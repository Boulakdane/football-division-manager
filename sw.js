'use strict';

/*
 * BSGST service worker: makes the app installable and keeps the shell
 * usable offline.
 *
 * Strategy: network-first for every same-origin GET, falling back to the cache
 * only when the network fails. That keeps a deployed JS/CSS change fresh while
 * still giving an installed app a start page at the pitch with no signal.
 *
 * What is cached: the app shell only (HTML, CSS, JS, fonts, icons). API and
 * auth responses are never cached: cross-origin requests are passed straight
 * through, so a shared device cannot serve one user's admin data to the next.
 *
 * Bump CACHE whenever index.html or a file in SHELL changes, otherwise an
 * offline client keeps the old shell.
 */

const CACHE = 'kickoff-shell-v3';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'favicon.svg',
  'css/fonts.css',
  'css/tailwind.css',
  'css/styles.css',
  'vendor/lucide-1.60.0.js',
  'vendor/supabase-js-2.118.0.js',
  'js/i18n.js',
  'js/store.js',
  'js/config.js',
  'js/backend.js',
  'js/auth.js',
  'js/mfa.js',
  'js/squad-import.js',
  'js/domain/index.js',
  'js/domain/format.js',
  'js/domain/standings.js',
  'js/domain/schedule.js',
  'js/domain/ics.js',
  'js/app.js',
  'js/pwa.js',
  'fonts/cairo-arabic-400-800.woff2',
  'fonts/cairo-latin-400-800.woff2',
  'fonts/cairo-latin-ext-400-800.woff2',
  'fonts/inter-latin-300-800.woff2',
  'fonts/inter-latin-ext-300-800.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => (response.ok ? response : Promise.reject(new Error('HTTP ' + response.status))))
        .catch(() => caches.match('index.html').then(cached => cached || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});
