// Service worker for offline audiobook playback (per-chapter model).
//
// Each chapter is its own URL (audio/chapter_NNNN.m4a) and its own cache entry.
// New chapters added to the deployed site do not invalidate previously-cached
// chapters. The legacy single-file `audio/book.m4b` entry is evicted on activate
// so old installs reclaim that storage.
var CACHE_NAME = 'audiobook-shell';
var AUDIO_CACHE = 'audiobook-audio';

var SHELL_FILES = [
  './',
  'player.css',
  'player.js',
  'feedback.js',
  'transcripts.json',
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
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    Promise.all([
      caches.keys().then(function (names) {
        return Promise.all(names.filter(function (name) {
          return name !== CACHE_NAME && name !== AUDIO_CACHE;
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

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  if (url.pathname.match(/\.(m4a|mp3|ogg|m4b)$/)) {
    e.respondWith(
      caches.open(AUDIO_CACHE).then(function (cache) {
        // Cache key is the URL without the Range header.
        var keyReq = new Request(e.request.url);
        return cache.match(keyReq).then(function (cached) {
          if (cached) return serveRange(e.request, cached);

          // Not cached: fetch the FULL file (no Range), cache as 200, then
          // serve the requested range from it. This makes the cache entry
          // always a complete 200 response.
          return fetch(fullRequest(e.request)).then(function (response) {
            if (!response || !response.ok || response.status !== 200) return response;
            cache.put(keyReq, response.clone()).catch(function () {});
            return serveRange(e.request, response);
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
