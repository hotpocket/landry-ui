// Service worker for offline audiobook playback.
// Updates automatically when CACHE_VERSION changes.
var CACHE_VERSION = 'v1';
var CACHE_NAME = 'audiobook-' + CACHE_VERSION;

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

// Serve a Range request from a cached response using Blob.slice (no full read into memory)
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
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

// Fetch: serve from cache, fall back to network
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // Audio files: serve from cache with Range support, fall back to network
  if (url.pathname.match(/\.(m4b|mp3|m4a|ogg)$/)) {
    e.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(new Request(e.request.url)).then(function (cached) {
          if (cached) return serveRange(e.request, cached);
          return fetch(e.request);
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

