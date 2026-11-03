'use strict';

/*
 * Installable app (PWA) support.
 *
 * Chrome and Edge fire `beforeinstallprompt` once the manifest, icons and
 * service worker qualify; we keep that event and replay it from the Download app
 * button, because a prompt is only allowed inside a user gesture.
 *
 * Safari and Firefox never fire the event. The same button then explains the
 * manual path (Share > Add to Home Screen on iOS, the browser menu elsewhere)
 * instead of being hidden, so the action is never a dead end.
 */

(function () {
  let deferredPrompt = null;
  let installed = isInstalled();

  function isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      window.navigator.standalone === true;
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
      (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  }

  function translate(key, fallback) {
    return typeof t === 'function' ? t(key) : fallback;
  }

  function toast(message) {
    if (typeof showToast === 'function') showToast(message);
    else window.alert(message);
  }

  /** Hide the button once the app runs as an installed window. */
  function refreshInstallButtons() {
    const hide = installed || isInstalled();
    document.querySelectorAll('[data-action="install-app"]').forEach(button => {
      button.classList.toggle('hidden', hide);
      button.setAttribute('aria-hidden', hide ? 'true' : 'false');
    });
  }

  globalThis.installApp = function () {
    if (deferredPrompt) {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      prompt.prompt();
      if (prompt.userChoice && typeof prompt.userChoice.then === 'function') {
        prompt.userChoice.then(choice => {
          if (choice && choice.outcome === 'accepted') {
            installed = true;
            refreshInstallButtons();
          }
        }).catch(() => {
          // A dismissed prompt is not an error; the button stays available.
        });
      }
      return;
    }

    toast(translate(
      isIos() ? 'installAppIos' : 'installAppHint',
      'Open the browser menu and choose Install app / Add to Home screen.'
    ));
  };

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
  });

  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    refreshInstallButtons();
    toast(translate('installAppDone', 'App installed.'));
  });

  if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        // Online use and installation still work if offline caching is blocked.
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshInstallButtons);
  } else {
    refreshInstallButtons();
  }
})();
