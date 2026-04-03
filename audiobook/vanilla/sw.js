// Service worker for offline audiobook playback.
// Updates automatically when CACHE_VERSION changes.
var CACHE_VERSION = 'v1';
var CACHE_NAME = 'audiobook-' + CACHE_VERSION;

var SHELL_FILES = [
  './',
  'player.css',
  'player.js',
  'feedback.js',
  'transcripts.json'
];

// Install: cache the app shell (small files only — audio cached on play)
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) {
          return name.startsWith('audiobook-') && name !== CACHE_NAME;
        }).map(function (name) {
          return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

// Serve a Range request from a cached full response
function serveRange(request, cached) {
  var rangeHeader = request.headers.get('Range');
  if (!rangeHeader || !cached) return cached;

  return cached.arrayBuffer().then(function (buf) {
    var match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) return cached;

    var start = parseInt(match[1], 10);
    var end = match[2] ? parseInt(match[2], 10) : buf.byteLength - 1;
    end = Math.min(end, buf.byteLength - 1);

    return new Response(buf.slice(start, end + 1), {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.byteLength,
        'Content-Length': String(end - start + 1),
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

// Fetch: serve from cache, fall back to network, cache audio on first play
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // Audio files: handle Range requests from cache
  if (url.pathname.match(/\.(m4b|mp3|m4a|ogg)$/)) {
    e.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        // Match ignoring Range header (we handle it ourselves)
        return cache.match(e.request, { ignoreVary: true }).then(function (cached) {
          if (!cached) {
            // Also try without query string / varying headers
            return cache.match(new Request(e.request.url)).then(function (cached2) {
              if (cached2) return serveRange(e.request, cached2);
              return fetch(e.request).then(function (response) {
                if (response.status === 200) {
                  cache.put(new Request(e.request.url), response.clone());
                }
                return response;
              });
            });
          }
          return serveRange(e.request, cached);
        });
      })
    );
    return;
  }

  // Everything else: cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request).then(function (response) {
        return caches.open(CACHE_NAME).then(function (cache) {
          cache.put(e.request, response.clone());
          return response;
        });
      });
    })
  );
});

// Background Fetch: move completed download into cache
self.addEventListener('backgroundfetchsuccess', function (e) {
  e.waitUntil(
    (async function () {
      var cache = await caches.open(CACHE_NAME);
      var records = await e.registration.matchAll();
      for (var record of records) {
        var response = await record.responseReady;
        await cache.put(record.request, response);
      }
      // Notify open clients
      var clients = await self.clients.matchAll();
      for (var client of clients) {
        client.postMessage({ type: 'bgfetch-done', id: e.registration.id });
      }
    })()
  );
  e.updateUI({ title: 'Download complete' });
});

self.addEventListener('backgroundfetchfail', function (e) {
  e.updateUI({ title: 'Download failed' });
});
