'use strict';

/*
 * Regenerate the installable-app icons from the football mark in favicon.svg.
 *
 * The manifest needs exact PNG sizes; rendering the same SVG in Chromium keeps
 * the mark identical to the browser tab icon and avoids a binary editor in the
 * repository. `icon-192` / `icon-512` keep the rounded transparent corners;
 * the maskable icon and the iOS icon are full-bleed.
 *
 * usage: node tools/make-app-icons.js   (or npm run build:icons)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const OUT = path.join(__dirname, '..', 'icons');

const BALL = `
  <circle cx="32" cy="32" r="19" fill="#ffffff"/>
  <path d="M32 18l8 6-3 9H27l-3-9z" fill="#14532d"/>
  <path d="M16 29l7 5-2 8-8-2z" fill="#14532d"/>
  <path d="M48 29l-7 5 2 8 8-2z" fill="#14532d"/>
  <path d="M24 50l8-6 8 6-3 6H27z" fill="#14532d"/>
  <circle cx="32" cy="32" r="3.5" fill="#16a34a"/>
`;

const JOBS = [
  { file: 'icon-192.png', size: 192, full: false, scale: 1 },
  { file: 'icon-512.png', size: 512, full: false, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, full: true, scale: 0.72 },
  { file: 'apple-touch-icon.png', size: 180, full: true, scale: 0.8 }
];

function iconSvg(full, scale) {
  const background = full
    ? '<rect width="64" height="64" fill="#16a34a"/>'
    : '<rect width="64" height="64" rx="14" fill="#16a34a"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 64 64">
  ${background}
  <g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${BALL}</g>
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (const job of JOBS) {
    await page.setViewportSize({ width: job.size, height: job.size });
    const background = job.full ? '#16a34a' : 'transparent';
    await page.setContent(
      `<!doctype html><html><head><style>
         html, body { margin: 0; width: 100%; height: 100%; background: ${background}; }
         svg { display: block; }
       </style></head><body>${iconSvg(job.full, job.scale)}</body></html>`
    );
    await page.screenshot({
      path: path.join(OUT, job.file),
      omitBackground: !job.full,
      clip: { x: 0, y: 0, width: job.size, height: job.size }
    });
    console.log(`${job.file}: ${job.size}x${job.size}${job.full ? ' (full bleed)' : ''}`);
  }

  await browser.close();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
