#!/usr/bin/env node
/*
 * Lightweight database keepalive for Supabase Free.
 *
 * Supabase pauses a Free project after roughly 7 days without enough user
 * database activity. Its docs say a few requests per day are typically enough.
 * Run this from an external scheduler (GitHub Actions) every 6 hours.
 *
 * Usage:
 *   node tools/keepalive.js            # production
 *   node tools/keepalive.js --env=dev  # development
 *
 * No admin session or secret is used: this is a normal public read.
 */

'use strict';

const { fail, readConfig } = require('./supabase-config');

const envArg = (process.argv.slice(2).find(a => a.startsWith('--env=')) || '--env=prod').split('=')[1];

(async () => {
  const base = readConfig(envArg);
  const envName = envArg === 'dev' ? 'development' : 'production';
  console.log(`Pinging ${envName} at ${base.url}`);

  let response;
  try {
    response = await fetch(`${base.url}/rest/v1/seasons?select=id&limit=1`, {
      headers: {
        apikey: base.key,
        Authorization: 'Bearer ' + base.key,
        Accept: 'application/json'
      }
    });
  } catch (error) {
    fail(`Could not reach ${envName}: ${error.message}`);
  }

  if (!response.ok) {
    const body = await response.text();
    fail(`${envName} returned ${response.status}: ${body.slice(0, 300)} ` +
      '(if this is a 503, the project may be paused — resume it in the Supabase dashboard).');
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) fail(`${envName} returned an unexpected response.`);
  console.log(`OK: ${envName} answered with ${rows.length} season row(s).`);
})().catch(error => fail(error && error.message ? error.message : String(error)));
