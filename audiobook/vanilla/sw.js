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

// Fetch: serve from cache, fall back to network, cache audio on first play
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // Audio files: cache on first request (too large to pre-cache)
  if (url.pathname.match(/\.(m4b|mp3|m4a|ogg)$/)) {
    e.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(e.request).then(function (cached) {
          if (cached) return cached;
          return fetch(e.request).then(function (response) {
            // Only cache complete responses (not partial/range)
            if (response.status === 200) {
              cache.put(e.request, response.clone());
            }
            return response;
          });
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
