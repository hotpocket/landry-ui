// Service worker for offline audiobook playback.
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

// Install: cache the app shell (always re-fetched on sw update)
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old shell caches but preserve audio cache
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) {
          return name !== CACHE_NAME && name !== AUDIO_CACHE;
        }).map(function (name) {
          return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

// Serve a Range request from a cached response using Blob.slice
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

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // Audio files: serve from audio cache with Range support, fall back to network
  if (url.pathname.match(/\.(m4b|mp3|m4a|ogg)$/)) {
    e.respondWith(
      caches.open(AUDIO_CACHE).then(function (cache) {
        return cache.match(new Request(e.request.url)).then(function (cached) {
          if (cached) return serveRange(e.request, cached);
          return fetch(e.request);
        });
      })
    );
    return;
  }

  // Shell files: network first, cache fallback (always get latest when online)
  // When offline, check shell cache then audio cache (transcripts stored in both)
  var requestUrl = e.request.url;
  e.respondWith(
    fetch(e.request).then(function (response) {
      return caches.open(CACHE_NAME).then(function (cache) {
        cache.put(requestUrl, response.clone());
        return response;
      });
    }).catch(function () {
      // Offline: search all caches by URL (ignoring headers/mode differences)
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
