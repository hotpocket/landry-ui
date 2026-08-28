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

// --- evicting audio that can no longer be current ---------------------------
//
// LEGACY_AUDIO_KEYS used to live here: a hand-written list of two URLs — the
// single-file book.m4b from the pre-chapter architecture, and one chapter
// recalled after a bad generation shipped under the same name. It was the right
// instinct and the wrong shape. THE CLASS it was one sample of: every artifact
// derived from source/N.txt that is addressed by a name which does not move
// when the text does. A list has to be edited by whoever notices; the rule
// below needs nobody to notice.
//
// The rule has two halves, because two different things can be stale:
//
//   1. UNVERSIONED entries under a signed path (activate). Audio published to
//      books.landry.bot now carries `?v=<content_hash>`, so an entry without
//      one was cached before versioning existed and there is no way to ask
//      whether it is current — it can only be dropped. Both of the old
//      LEGACY_AUDIO_KEYS are unversioned by construction, so this covers them
//      and everything else that shipped alongside them.
//
//   2. SUPERSEDED renders (on a manifest message from the page). `?v=old` and
//      `?v=new` are different keys, so the old one is never served again — but
//      it is also never removed, and a 1,128-chapter book re-rendered chapter
//      by chapter would eventually hold two copies of most of itself in a
//      reader's PWA with nothing on screen to say so. Only the page knows
//      which renders are current, so the page tells us.
//
// The gate on half 1 is the signed path, and it is the same gate the signature
// repair uses further down: this worker ships byte-identical to sites that
// serve unsigned audio from manifests with no hashes (RETIREMENT.md), where
// EVERY entry is unversioned. Evicting there would delete an offline download
// on every deploy and re-download it on every visit.
var AUDIO_EXT = /\.(m4a|mp3|ogg|m4b)$/;

// Kept OUT of the stripped-parameter list below, unlike the signature: the
// signature says who may fetch the bytes, this says WHICH bytes. One spelling,
// shared with player-src/src/core/media-url.ts (CONTENT_VERSION_PARAM), and
// test/audio-versioning.test.mjs reads both files and fails if they drift.
var CONTENT_VERSION_PARAM = 'v';

function dirOf(pathname) {
  return pathname.slice(0, pathname.lastIndexOf('/') + 1);
}

// Both audio caches. The shell cache is not swept: it is keyed by build and
// activate() already deletes every cache that is not the current name.
//
// `shouldDelete(url, context)` is handed a `versionedDirs` map alongside each
// entry, because both halves need to know what the CACHE AS A WHOLE looks like
// and neither can tell from one key.
function sweepAudio(shouldDelete) {
  return Promise.all([AUDIO_CACHE, STREAM_CACHE].map(function (name) {
    return caches.open(name).then(function (cache) {
      return cache.keys().then(function (requests) {
        var audio = [];
        var versionedDirs = {};
        requests.forEach(function (req) {
          var u;
          try { u = new URL(req.url); } catch (err) { return; }
          // Shell files live in AUDIO_CACHE too — downloadForOffline puts
          // player.js, the transcript and the icons there so the app opens
          // offline — and the stream cache holds its own FIFO index. Only
          // audio is ours to evict.
          if (!AUDIO_EXT.test(u.pathname)) return;
          audio.push([req, u]);
          if (u.searchParams.get(CONTENT_VERSION_PARAM)) {
            versionedDirs[dirOf(u.pathname)] = true;
          }
        });
        return Promise.all(audio.map(function (pair) {
          return shouldDelete(pair[1], versionedDirs) ? cache.delete(pair[0]) : null;
        }));
      });
    }).catch(function () {
      // A cache that will not open (quota, a browser that refuses storage) is
      // one that has nothing stale in it either. Never a failed activation.
    });
  }));
}

// Half 1. SIGNED_PATH is declared further down, next to the signature repair
// that is its other user; this only reads it when the sweep actually runs.
//
// Two conditions, and the second one matters as much as the first. An entry is
// dropped when it carries no version AND a versioned entry exists in the same
// directory — that is, the book has moved to content addressing and this entry
// predates the move. Without the second condition, a book on this site whose
// manifest has no content_hash yet (an older chatterbook wrote it) would have
// its CURRENT audio deleted on every shell deploy, and the reader would be
// handed a re-download of a book they had already downloaded. Those books lose
// nothing by waiting: the page sweeps a book's directory precisely when it
// opens it (evictSupersededAudio), which is the moment the answer is known.
function evictUnversionedAudio() {
  return sweepAudio(function (u, versionedDirs) {
    if (!SIGNED_PATH.test(u.pathname)) return false;
    if (u.searchParams.get(CONTENT_VERSION_PARAM)) return false;
    return !!versionedDirs[dirOf(u.pathname)];
  });
}

// Half 2. `keys` is the exact set of cache keys the open book is made of. Only
// the DIRECTORIES those keys name are swept, so one book's manifest never
// speaks for another's — a reader with two books downloaded must not lose one
// by opening the other.
function evictSupersededAudio(keys) {
  var want = {};
  var dirs = {};
  (keys || []).forEach(function (k) {
    var u;
    try { u = new URL(k); } catch (err) { return; }
    want[u.href] = true;
    dirs[dirOf(u.pathname)] = true;
  });
  // An empty manifest means "I could not tell you", never "delete everything".
  if (!Object.keys(want).length) return Promise.resolve();
  return sweepAudio(function (u) {
    return !!dirs[dirOf(u.pathname)] && !want[u.href];
  });
}

// The page's half of the contract. See media-url.ts's AUDIO_MANIFEST_MESSAGE.
var AUDIO_MANIFEST_MESSAGE = 'audiobook-manifest';

self.addEventListener('message', function (e) {
  var data = e.data || {};
  if (data.type !== AUDIO_MANIFEST_MESSAGE) return;
  // The reply exists so a caller CAN wait for the sweep. Nothing in the player
  // does; the test does, because polling for an absence cannot tell a sweep
  // that found nothing from a sweep that never ran.
  var port = e.ports && e.ports[0];
  e.waitUntil(evictSupersededAudio(data.keys).then(function () {
    if (port) port.postMessage({ swept: true });
  }).catch(function () {
    if (port) port.postMessage({ swept: false });
  }));
});

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
      // Audio whose render cannot be established. See evictUnversionedAudio.
      evictUnversionedAudio()
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

// --- repairing an expired signature -----------------------------------------
//
// A signed media URL carries its own expiry, and the page cannot rewrite a URL
// a fetch is already in flight on. When it lapses, every request that reaches
// the network 403s — and the ones that reach the network are precisely the ones
// nothing else can see: a prefetch, a chapter past the cache, a mid-file seek
// issued by the media element itself. On 2026-08-13 that produced ten hours of
// 403s behind a perfectly healthy session, because CloudFront uses the URL
// signature and IGNORES the cookies when a request carries both — so the thing
// being refreshed could not have helped.
//
// So the worker repairs it here, where every one of those requests passes:
// mint a fresh signature for the book the path names, retry once.
//
// The path shape is the gate. This worker ships byte-identical to sites that
// serve their audio unsigned and have no such API (see RETIREMENT.md), and a
// 403 there must stay a 403 rather than becoming a request to a route that
// does not exist.
var SIGNED_PATH = /^\/priv\/([0-9a-zA-Z_-]{1,64})\/([0-9a-zA-Z_-]{1,64})\//;

// The last mint that worked, per book, and the mint currently in flight. Both
// live in worker memory: a killed worker just starts over, and the cost of
// starting over is one extra API call.
var freshQuery = {};
var minting = {};

function mintQuery(bookId) {
  if (!minting[bookId]) {
    // credentials matter: the route authorizes with the session cookie, and a
    // fetch from a worker does not send one unless asked.
    minting[bookId] = fetch('/api/books/' + encodeURIComponent(bookId) + '/media',
                            { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) { return (body && body.media_query) || null; })
      .catch(function () { return null; })   // offline: nothing to repair with
      .then(function (query) {
        delete minting[bookId];
        if (query) freshQuery[bookId] = query;
        return query;
      });
  }
  return minting[bookId];
}

function withQuery(url, query) {
  var u = new URL(url);
  SIGNED_PARAMS.forEach(function (p) { u.searchParams.delete(p); });
  new URLSearchParams(query).forEach(function (v, k) { u.searchParams.set(k, v); });
  return u.href;
}

// The same request, re-aimed at a URL. Mirrors fullRequest: a Request cannot
// have its url reassigned, so everything that matters is copied across.
function reaimed(req, url) {
  var headers = new Headers();
  req.headers.forEach(function (v, k) { headers.append(k, v); });
  return new Request(url, {
    method: req.method, headers: headers, mode: req.mode,
    credentials: req.credentials, cache: 'no-store', redirect: req.redirect,
  });
}

/**
 * fetch(), repairing the signature when the edge refuses it.
 *
 * At most one MINT per request, and never a retry of a URL that has just been
 * refused. A freshly minted signature that is also refused means the
 * entitlement is gone rather than expired — the book was unshared, or made
 * private — and reloading that is a spin against a wall.
 */
function fetchSigned(req) {
  return fetch(req).then(function (response) {
    if (!response || response.status !== 403) return response;
    var m = SIGNED_PATH.exec(new URL(req.url).pathname);
    if (!m) return response;
    return repairSignature(req, m[2], response);
  });
}

function retryWith(req, query, denied) {
  var url = withQuery(req.url, query);
  // Reloading the URL that was just refused is not a retry, it is the same
  // request again — and the network stack may coalesce it onto the one that
  // already failed, so it would not even reach the edge.
  if (url === req.url) return Promise.resolve(denied);
  return fetch(reaimed(req, url));
}

function repairSignature(req, bookId, denied) {
  // The mint some other request already paid for. This is the burst case: a
  // chapter boundary and a prefetch are denied together, and both reaching for
  // the API would double the load at the moment the radio is already starving.
  var known = freshQuery[bookId];
  if (!known) return mintAndRetry(req, bookId, denied);

  return retryWith(req, known, denied).then(function (r) {
    if (r.status !== 403) return r;
    // The remembered one is refused too: it has expired in its turn, or the
    // library changed underneath it. Forget it and ask once.
    if (freshQuery[bookId] === known) delete freshQuery[bookId];
    return mintAndRetry(req, bookId, denied);
  });
}

function mintAndRetry(req, bookId, denied) {
  return mintQuery(bookId).then(function (query) {
    if (!query) return denied;              // offline, or a book we may not read
    // A mint that is refused is forgotten in ONE place — repairSignature, on
    // the next request that runs into it. Forgetting it here as well only
    // moves which request pays for the discovery, and a second copy of the
    // rule is a second thing that can drift from it.
    return retryWith(req, query, denied);
  });
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
          return fetchSigned(e.request);
        }

        // First request for the chapter. Return the network response AS A
        // STREAM — the old blob() here buffered the entire file before the
        // element saw byte one, a window of enforced silence in which a
        // phone with its screen off is free to suspend the page (the win is
        // time-to-first-byte; the cache branch of the tee still holds the
        // body). The cache copy fills in the background; a put that fails
        // (quota) triggers an eviction pass so the cache heals rather than
        // silently dying full.
        return fetchSigned(fullRequest(e.request)).then(function (response) {
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

  // A content hash in the URL makes the response immutable by construction:
  // new bytes are published under a new `?v=`, so a cached entry can never be
  // stale for the URL that names it. Going to the network first to be told
  // that was a round trip on every asset on every load — 0.1-0.3 s of a cold
  // page load spent confirming an answer that could not have changed.
  //
  // index.html deliberately carries no hash: it is the file that POINTS at the
  // new hashes, so it falls through to the network-first branch below. Pinning
  // it here would freeze the whole shell at whatever version installed first
  // and no deploy would ever be picked up.
  if (url.searchParams.has('v')) {
    e.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(e.request).then(function (hit) {
          if (hit) return hit;
          return fetch(e.request).then(function (response) {
            // Same rule as the shell branch: only a good response is stored.
            // A cached 403 here would be permanent, because nothing would ever
            // go back to the network for this URL again.
            //
            // waitUntil, not await: the bytes go to the page as soon as they
            // arrive, and the cache write outlives the response. Awaiting the
            // write first would put a disk round trip in front of every asset
            // on its first load, which is the cost this branch exists to
            // remove.
            if (response.ok) e.waitUntil(cache.put(e.request, response.clone()));
            return response;
          });
        });
      })
    );
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
