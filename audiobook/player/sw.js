// Service worker for offline audiobook playback (per-chapter model).
//
// Each chapter is its own URL (audio/chapter_NNNN.m4a) and its own cache entry.
// New chapters added to the deployed site do not invalidate previously-cached
// chapters. The legacy single-file `audio/book.m4b` entry is evicted on activate
// so old installs reclaim that storage.
// SHELL_VERSION is the one line build tooling stamps, with a content hash of the
// shell it just produced. Two things depend on it changing:
//
//   1. The browser only reinstalls a service worker whose bytes changed. With a
//      constant cache name, a rebuilt site keeps serving the previous build's
//      cached index.html whenever the network is unreachable — and because the
//      book's chapter list is inlined into index.html, that shows up as an old
//      chapter list against current audio, which reads as data loss.
//   2. activate() evicts every cache that isn't the current name, so bumping
//      this is also what garbage-collects the previous build's shell.
//
// Leave it as 'dev' when serving the component directly; hosts that publish a
// site should stamp it. See README for the one-line sed.
var SHELL_VERSION = 'dev';

var CACHE_NAME = 'audiobook-shell-' + SHELL_VERSION;
// Two audio caches with different owners:
//   AUDIO_CACHE  — explicit offline downloads (the page writes it; never
//                  evicted here, because "Downloaded ✓" is a promise).
//   STREAM_CACHE — chapters cached as a side effect of listening. Bounded:
//                  a 1,000-chapter book listened straight through must not
//                  silently swallow gigabytes and get the whole origin's
//                  storage (localStorage progress included) evicted by quota.
var AUDIO_CACHE = 'audiobook-audio';
var STREAM_CACHE = 'audiobook-stream';
var STREAM_MAX_ENTRIES = 20;
// FIFO order lives in the cache itself (a synthetic entry), not in worker
// memory — the worker is killed and restarted constantly.
var STREAM_INDEX_URL = '/__audiobook-stream-index__';

// Versioned so a rebuilt transcript is refetched rather than served from the
// previous build's cache entry. Kept unversioned in dev so local edits show up
// on reload without a rebuild.
var TRANSCRIPTS_FILE = SHELL_VERSION === 'dev'
  ? 'transcripts.json'
  : 'transcripts.json?v=' + SHELL_VERSION;

var SHELL_FILES = [
  './',
  'player.css',
  'player.js',
  'feedback.js',
  TRANSCRIPTS_FILE,
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// One-time eviction of legacy single-file caches from prior architecture,
// plus chapters recalled after a bad generation shipped (same URL, new bytes —
// the immutable HTTP cache and this SW cache would otherwise never refetch).
var LEGACY_AUDIO_KEYS = ['audio/book.m4b', 'audio/chapter_1073.m4a'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Deliberately not cache.addAll(): addAll is atomic, so a single missing
      // file rejects the whole batch and leaves the shell cache EMPTY. A site
      // published before its transcripts.json existed would install a worker
      // that caches nothing at all, offline would break entirely, and no error
      // would surface anywhere. Cache each file on its own merits instead and
      // let the rest survive one bad entry.
      return Promise.all(SHELL_FILES.map(function (file) {
        return cache.add(file).catch(function (err) {
          console.warn('[sw] shell file not cached:', file, err);
        });
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    Promise.all([
      caches.keys().then(function (names) {
        return Promise.all(names.filter(function (name) {
          return name !== CACHE_NAME && name !== AUDIO_CACHE && name !== STREAM_CACHE;
        }).map(function (name) { return caches.delete(name); }));
      }),
      // Evict legacy single-file M4B from audio cache (one-time cleanup).
      caches.open(AUDIO_CACHE).then(function (cache) {
        return cache.keys().then(function (requests) {
          return Promise.all(requests.map(function (req) {
            var url = new URL(req.url);
            for (var i = 0; i < LEGACY_AUDIO_KEYS.length; i++) {
              if (url.pathname.endsWith(LEGACY_AUDIO_KEYS[i])) {
                return cache.delete(req);
              }
            }
            return null;
          }));
        });
      })
    ])
  );
  self.clients.claim();
});

// Slice a cached full (200) response to satisfy a browser Range request.
function serveRange(request, cached) {
  var rangeHeader = request.headers.get('Range');
  if (!rangeHeader || !cached) return Promise.resolve(cached);

  return cached.blob().then(function (blob) {
    var match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) return cached;

    var start = parseInt(match[1], 10);
    var end = match[2] ? parseInt(match[2], 10) : blob.size - 1;
    end = Math.min(end, blob.size - 1);

    // Only `end` is clamped, so `start` can overtake it — a seek into a cached
    // entry that is shorter than the file it stands for, which is what a stale
    // cache of a re-encoded chapter looks like. The slice would come back empty
    // while the headers claimed 'bytes 5000-4999/4000' and a negative
    // Content-Length, leaving the media element to interpret a malformed 206.
    // 416 says the same thing in a way it already knows how to handle.
    if (!(start >= 0) || start > end) {
      return new Response(null, {
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: { 'Content-Range': 'bytes */' + blob.size }
      });
    }

    return new Response(blob.slice(start, end + 1), {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + blob.size,
        'Content-Length': String(end - start + 1),
        'Content-Type': cached.headers.get('Content-Type') || 'audio/mp4',
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

// Build a non-Range Request from an incoming Range request, used to fetch the
// full file once and cache it as a 200. Subsequent Range requests slice the
// cached 200 via serveRange().
function fullRequest(req) {
  var headers = new Headers();
  req.headers.forEach(function (v, k) {
    if (k.toLowerCase() !== 'range') headers.append(k, v);
  });
  return new Request(req.url, {
    method: req.method,
    headers: headers,
    mode: req.mode,
    credentials: req.credentials,
    // 'no-store' bypasses the browser HTTP cache entirely so the SW always
    // receives the full body (Python http.server otherwise returns 304 on
    // If-Modified-Since, which 'no-cache' would trigger).
    cache: 'no-store',
    redirect: req.redirect
  });
}

// Record a freshly-streamed chapter and evict the oldest past the cap.
//
// The index is read-modify-write, and the player prefetches the next chapter
// while the current one is still filling the cache — two writers ARE
// concurrent, so every update runs on one serial chain. The chain lives in
// worker memory (a killed worker just starts a fresh, empty chain; the index
// itself is in the cache), and each pass also reconciles the index against
// the cache's real keys, so an entry orphaned by a worker death mid-write is
// swept up on the next one rather than pinned forever.
var indexChain = Promise.resolve();

function recordStreamEntry(cache, urlHref) {
  indexChain = indexChain.then(function () {
    var indexReq = new Request(STREAM_INDEX_URL);
    return Promise.all([
      cache.match(indexReq).then(function (r) {
        return r ? r.json().catch(function () { return []; }) : [];
      }),
      cache.keys(),
    ]).then(function (got) {
      var order = got[0];
      var real = {};
      got[1].forEach(function (req) {
        var path = new URL(req.url).pathname;
        if (path !== STREAM_INDEX_URL) real[req.url] = true;
      });
      if (urlHref) {
        order = order.filter(function (u) { return u !== urlHref; });
        order.push(urlHref);
      }
      // Reconcile both ways: index entries whose object vanished are dropped;
      // cached objects the index never heard of join the front (oldest end),
      // first in line for eviction.
      var known = {};
      order = order.filter(function (u) { known[u] = true; return real[u]; });
      var strays = Object.keys(real).filter(function (u) { return !known[u]; });
      order = strays.concat(order);
      var evict = order.slice(0, Math.max(0, order.length - STREAM_MAX_ENTRIES));
      order = order.slice(evict.length);
      return Promise.all(evict.map(function (u) {
        return cache.delete(new Request(u));
      })).then(function () {
        return cache.put(indexReq, new Response(JSON.stringify(order),
          { headers: { 'Content-Type': 'application/json' } }));
      });
    });
  }).catch(function () {});
  return indexChain;
}

// Media is authorized by a signature in the query string, and that signature
// rotates every time the API mints one. Cached bytes are keyed WITHOUT it: the
// object is the same object however the request was authorized, so a fresh
// signature still finds it and an expired one never re-downloads a 141-hour
// book. Authorization is still enforced — but on the network fetch, which is
// the only place it can be. If you already hold the bytes, you hold them.
// `rsr` joins them for the same reason: the player appends it to force a
// genuinely new request when a chapter's fetch has hung (reloading the identical
// URL is coalesced onto the stuck request and recovers nothing). It identifies
// an ATTEMPT, not an object — keyed on, a stalled chapter would land in the
// cache once per recovery and evict the rest of the book to hold the copies.
var SIGNED_PARAMS = ['Policy', 'Signature', 'Key-Pair-Id', 'rsr'];

function cacheKeyUrl(url) {
  try {
    var u = new URL(url);
    SIGNED_PARAMS.forEach(function (p) { u.searchParams.delete(p); });
    // Drop a query that is now empty so the key matches an unsigned host's URL
    // exactly (karagame and brandonlandry.com serve these files unsigned).
    if (!u.searchParams.toString()) u.search = '';
    return u.href;
  } catch (err) {
    return url;
  }
}

function audioResponse(e) {
  var keyReq = new Request(cacheKeyUrl(e.request.url));
  return Promise.all([caches.open(AUDIO_CACHE), caches.open(STREAM_CACHE)])
    .then(function (opened) {
      var offline = opened[0], stream = opened[1];
      return offline.match(keyReq).then(function (r) {
        return r || stream.match(keyReq);
      }).then(function (cached) {
        if (cached) return serveRange(e.request, cached);

        var rangeHeader = e.request.headers.get('Range') || '';
        var range = rangeHeader.match(/bytes=(\d*)-/);
        // A suffix range (bytes=-N, Safari probing for the moov atom) has an
        // empty first group; it must pass through like a mid-file seek, not
        // fall into the whole-file branch.
        var start = range && range[1] !== '' ? parseInt(range[1], 10) : (range ? null : 0);
        if (start !== 0) {
          // A mid-file seek into an uncached chapter: pass it straight
          // through. Buffering the whole file first would stall the seek,
          // and a 206 must not be cached as if it were the full body.
          return fetch(e.request);
        }

        // First request for the chapter. Return the network response AS A
        // STREAM — the old blob() here buffered the entire file before the
        // element saw byte one, a window of enforced silence in which a
        // phone with its screen off is free to suspend the page (the win is
        // time-to-first-byte; the cache branch of the tee still holds the
        // body). The cache copy fills in the background; a put that fails
        // (quota) triggers an eviction pass so the cache heals rather than
        // silently dying full.
        return fetch(fullRequest(e.request)).then(function (response) {
          if (!response || response.status !== 200) return response;  // errors are never cached
          var copy = response.clone();
          e.waitUntil(
            stream.put(keyReq, copy).then(function () {
              return recordStreamEntry(stream, keyReq.url);
            }).catch(function () {
              return recordStreamEntry(stream, null);  // reconcile + evict
            })
          );
          // The element asked for a range; strict UAs (iOS Safari) may not
          // accept a 200 in its place. With the length known we can answer
          // 206 and still stream the same body.
          var len = response.headers.get('Content-Length');
          if (rangeHeader && len) {
            return new Response(response.body, {
              status: 206,
              statusText: 'Partial Content',
              headers: {
                'Content-Type': response.headers.get('Content-Type') || 'audio/mp4',
                'Content-Range': 'bytes 0-' + (parseInt(len, 10) - 1) + '/' + len,
                'Content-Length': len,
                'Accept-Ranges': 'bytes'
              }
            });
          }
          return response;
        });
      });
    });
}

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // The API is authoritative and cookie-bearing: never cached, never served
  // stale, never satisfied from here at all.
  if (url.pathname.indexOf('/api/') === 0) return;

  if (url.pathname.match(/\.(m4a|mp3|ogg|m4b)$/)) {
    e.respondWith(audioResponse(e));
    return;
  }

  // Shell files: network-first, fall back to cache when offline.
  var requestUrl = e.request.url;
  e.respondWith(
    fetch(e.request).then(function (response) {
      // Only a good response replaces the cached copy: caching a 403/404/500
      // here poisoned the shell cache — a transient auth lapse left a private
      // book's transcript permanently "empty" until the cache was cleared.
      if (!response.ok) return response;
      return caches.open(CACHE_NAME).then(function (cache) {
        cache.put(requestUrl, response.clone());
        return response;
      });
    }).catch(function () {
      return caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(requestUrl);
      }).then(function (cached) {
        if (cached) return cached;
        return caches.open(AUDIO_CACHE).then(function (cache) {
          return cache.match(requestUrl);
        });
      }).then(function (cached) {
        return cached || new Response('Offline', { status: 503 });
      });
    })
  );
});
