#!/usr/bin/env node
/*
 * Static checks for the installable app (PWA): manifest, icons, service worker,
 * install button and translations.
 *
 * These run without a browser, so they catch the mistakes a manual check misses:
 * an icon whose real pixel size disagrees with the manifest, a shell file that
 * was renamed but not updated in sw.js, a missing Arabic string, or a manifest
 * link that was dropped from index.html (which silently disables installation).
 *
 * Usage: npm run test:pwa
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

let failed = 0;
let passed = 0;
function check(label, ok, extra) {
  if (ok) {
    passed += 1;
    console.log('  ok   ' + label);
  } else {
    failed += 1;
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  }
}

/** Width and height from a PNG IHDR chunk, or null when the file is not a PNG. */
function pngSize(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const signature = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== signature) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Load js/i18n.js in a small sandbox and return its dictionary. */
function loadI18N() {
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      documentElement: { setAttribute: () => {} }
    },
    window: { addEventListener: () => {} },
    navigator: { language: 'en' }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read('js/i18n.js'), context, { filename: 'js/i18n.js' });
  return vm.runInContext('I18N', context);
}

/** Local files index.html loads directly (scripts, styles, manifest, icons). */
function indexAssets() {
  const html = read('index.html');
  const found = new Set();
  const attribute = /\b(?:src|href)="([^"]+)"/g;
  let match;
  while ((match = attribute.exec(html))) {
    const value = match[1].split('?')[0];
    if (!value || /^(?:[a-z]+:|\/\/|#|data:)/i.test(value)) continue;
    found.add(value.replace(/^\.\//, ''));
  }
  return found;
}

function main() {
  console.log('manifest.webmanifest');
  let manifest = null;
  try {
    manifest = JSON.parse(read('manifest.webmanifest'));
    check('is valid JSON', true);
  } catch (error) {
    check('is valid JSON', false, error.message);
  }

  if (manifest) {
    check('name and short_name set', Boolean(manifest.name && manifest.short_name), {
      name: manifest.name, short_name: manifest.short_name
    });
    check('starts inside the deployed scope', manifest.start_url === './' && manifest.scope === './',
      { start_url: manifest.start_url, scope: manifest.scope });
    check('installs as a standalone window', manifest.display === 'standalone', manifest.display);
    check('has theme and background colours', Boolean(manifest.theme_color && manifest.background_color),
      { theme: manifest.theme_color, background: manifest.background_color });

    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    const sized = size => icons.find(icon => String(icon.sizes || '').split(/\s+/).includes(size));
    const any192 = sized('192x192');
    const any512 = sized('512x512');
    const maskable = icons.find(icon => String(icon.purpose || '').split(/\s+/).includes('maskable'));
    check('declares a 192px and a 512px icon', Boolean(any192 && any512), icons);
    check('declares a maskable icon', Boolean(maskable), icons);

    for (const icon of icons) {
      check('icon file exists: ' + icon.src, exists(icon.src), icon.src);
      if (!exists(icon.src)) continue;
      const size = pngSize(icon.src);
      const declared = String(icon.sizes || '').split(/\s+/)[0];
      check('icon is a PNG: ' + icon.src, Boolean(size), icon.src);
      check('icon pixels match the manifest: ' + icon.src,
        Boolean(size) && size.width + 'x' + size.height === declared,
        { pixels: size, declared });
      check('icon type is image/png: ' + icon.src, icon.type === 'image/png', icon.type);
    }
  }

  console.log('index.html');
  const html = read('index.html');
  check('links the manifest', /<link[^>]+rel="manifest"[^>]+href="manifest\.webmanifest"/.test(html));
  check('links the iOS icon', /<link[^>]+rel="apple-touch-icon"[^>]+href="icons\/apple-touch-icon\.png"/.test(html));
  check('declares the iOS standalone flag', /name="apple-mobile-web-app-capable"\s+content="yes"/.test(html));
  check('declares a theme colour', /<meta[^>]+name="theme-color"/.test(html));
  check('loads js/pwa.js', /<script[^>]+src="js\/pwa\.js(\?[^"]*)?"[^>]*>/.test(html));

  const installButtons = (html.match(/data-action="install-app"/g) || []).length;
  check('has an install action in the header and the footer', installButtons >= 2, installButtons);
  check('the install button is translated (data-i18n-title)',
    /data-action="install-app"[^>]*data-i18n-title="installApp"/.test(html) ||
    /data-i18n-title="installApp"[^>]*data-action="install-app"/.test(html));

  console.log('js/pwa.js');
  const pwa = read('js/pwa.js');
  check('registers the service worker', /serviceWorker\.register\('sw\.js'\)/.test(pwa));
  check('keeps beforeinstallprompt for a later click', /addEventListener\('beforeinstallprompt'/.test(pwa));
  check('exposes the installApp action', /installApp\s*=\s*function/.test(pwa));
  check('hides the button once installed', /display-mode: standalone/.test(pwa));
  check('explains the iOS path', /installAppIos/.test(pwa));
  check('never registers from file://', /protocol !== 'file:'/.test(pwa));

  console.log('sw.js');
  const sw = read('sw.js');
  check('skips non-GET requests', /request\.method !== 'GET'/.test(sw));
  check('never caches another origin (Supabase, auth)', /url\.origin !== self\.location\.origin/.test(sw));

  const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  check('declares the shell list', Boolean(shellMatch));
  if (shellMatch) {
    const files = (shellMatch[1].match(/'[^']+'/g) || []).map(entry => entry.slice(1, -1));
    check('shell list is not empty', files.length > 10, files.length);
    check('caches the start page', files.includes('./') && files.includes('index.html'), files.slice(0, 3));
    for (const file of files) {
      if (file === './') continue;
      check('shell file exists: ' + file, exists(file), file);
    }

    // Everything index.html loads must survive offline, otherwise the first
    // offline reload shows a half-rendered app.
    const loaded = indexAssets();
    const missing = [...loaded].filter(asset => !files.includes(asset));
    check('every script, style and icon used by index.html is cached', missing.length === 0, missing);

    const css = read('css/fonts.css');
    const fonts = (css.match(/url\(\.\.\/(fonts\/[^)]+)\)/g) || [])
      .map(entry => entry.slice(7, -1));
    const missingFonts = fonts.filter(font => !files.includes(font));
    check('every self-hosted font is cached', fonts.length > 0 && missingFonts.length === 0, missingFonts);
  }

  console.log('translations');
  const i18n = loadI18N();
  const keys = ['installApp', 'installAppHint', 'installAppIos', 'installAppDone'];
  for (const lang of ['en', 'fr', 'ar']) {
    const dictionary = i18n[lang] || {};
    for (const key of keys) {
      check(lang + ': ' + key, typeof dictionary[key] === 'string' && dictionary[key].trim().length > 0, dictionary[key]);
    }
  }
  check('French and Arabic differ from English',
    i18n.fr.installApp !== i18n.en.installApp && i18n.ar.installApp !== i18n.en.installApp,
    { en: i18n.en.installApp, fr: i18n.fr.installApp, ar: i18n.ar.installApp });

  console.log('js/app.js');
  const app = read('js/app.js');
  check('dispatches the install-app action', /'install-app':/.test(app));

  console.log('tools/serve.js');
  const serve = read('tools/serve.js');
  check('serves .webmanifest as application/manifest+json',
    /'\.webmanifest':\s*'application\/manifest\+json/.test(serve));

  console.log('');
  console.log(failed === 0
    ? `PWA checks passed (${passed}).`
    : `PWA checks failed: ${failed} of ${passed + failed}.`);
  if (failed > 0) process.exit(1);
}

main();
