#!/usr/bin/env node
/*
 * Security drift monitor.
 *
 * Some protections live in the Supabase dashboard or in grants that nothing in the
 * repository can show: signups disabled, the admin MFA requirement, and "anonymous
 * visitors cannot write". This script checks them from the outside, exactly as an
 * attacker could, using only the public publishable key. Run it daily from CI.
 *
 * Usage:
 *   node tools/check-security-drift.js                 # production
 *   node tools/check-security-drift.js --env=dev       # development (settings not asserted)
 *   node tools/check-security-drift.js --json          # machine-readable result
 *   node tools/check-security-drift.js --markdown=report.md
 *   --expect-signups-disabled=true|false|any   (default: true for prod, any for dev)
 *   --expect-mfa=true|false|any                (default: true for prod, any for dev)
 *   --strict-warnings                          # treat WARN as failure
 *
 * Exit codes: 0 = no drift, 1 = drift detected, 2 = could not reach the project (inconclusive).
 *
 * Safety: every request is anonymous and aimed at a fake id (`__drift_probe__`) or sends
 * the safe direction of a toggle. Admin functions validate input and check permissions in
 * one transaction, so even a missing protection could not change real data. The probes are
 * the same requests any visitor could make, so running them discloses nothing new.
 */
'use strict';

const fs = require('fs');
const { fail, readConfig } = require('./supabase-config');

const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const option = (name, fallback) => {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const envArg = option('env', 'prod');
if (!['prod', 'dev'].includes(envArg)) fail('--env must be prod or dev');

function expectation(name, prodDefault) {
  const value = option(name, envArg === 'prod' ? String(prodDefault) : 'any');
  if (value === 'any') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(`--${name} must be true, false or any`);
}

const EXPECT = {
  signupsDisabled: expectation('expect-signups-disabled', true),
  mfaRequired: expectation('expect-mfa', true)
};

const PROBE_ID = '__drift_probe__';

/** Admin RPCs an anonymous caller must never be able to run. Param names match schema.sql. */
const ADMIN_RPCS = [
  ['create_season', { p_id: PROBE_ID, p_name: 'drift probe' }],
  ['activate_season', { p_id: PROBE_ID }],
  ['replace_match_events', { p_match_id: PROBE_ID, p_events: [] }],
  ['delete_match', { p_match_id: PROBE_ID }],
  ['save_match', { p_match: { id: PROBE_ID }, p_events: null }],
  ['delete_team', { p_team_id: PROBE_ID }],
  ['delete_season', { p_season_id: PROBE_ID }],
  ['restore_match', { p_match_id: PROBE_ID }],
  ['restore_team', { p_team_id: PROBE_ID }],
  ['restore_season', { p_season_id: PROBE_ID }],
  ['archive_player', { p_player_id: PROBE_ID }],
  ['restore_player', { p_player_id: PROBE_ID }],
  ['list_deleted', {}],
  ['list_audit_log', { p_limit: 1 }],
  ['replace_all_data', { p_data: { [PROBE_ID]: true } }],
  // The safe direction: if this ever ran, it could only turn the requirement on.
  ['set_require_admin_mfa', { p_required: true }]
];

/** Direct table writes an anonymous caller must never be able to make. */
const DIRECT_WRITES = [
  ['POST', '/rest/v1/teams', { id: PROBE_ID }],
  ['PATCH', `/rest/v1/teams?id=eq.${PROBE_ID}`, { name: 'drift probe' }],
  ['PATCH', `/rest/v1/matches?id=eq.${PROBE_ID}`, { status: 'FINISHED' }],
  ['POST', '/rest/v1/match_events', { id: PROBE_ID }],
  ['PATCH', `/rest/v1/seasons?id=eq.${PROBE_ID}`, { name: 'drift probe' }],
  ['DELETE', `/rest/v1/players?id=eq.${PROBE_ID}`, undefined]
];

/** Tables whose rows must stay invisible to anonymous visitors. */
const PRIVATE_TABLES = ['profiles', 'audit_log', 'security_settings'];

const base = readConfig(envArg);
const envName = envArg === 'dev' ? 'development' : 'production';
const results = [];
const record = (status, name, detail) => results.push({ status, name, detail });

class Unreachable extends Error {}

async function call(method, path, body) {
  const request = () => fetch(base.url + path, {
    method,
    headers: {
      apikey: base.key,
      Authorization: 'Bearer ' + base.key,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });

  let response;
  try {
    response = await request();
  } catch (first) {
    try { response = await request(); } catch (second) {
      throw new Unreachable(`${method} ${path.split('?')[0]}: ${second.message}`);
    }
  }
  if (response.status >= 500) {
    throw new Unreachable(`${method} ${path.split('?')[0]} returned ${response.status} (project paused or down?)`);
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { /* not JSON */ }
  return { status: response.status, json, text };
}

const snippet = res => (res.text || '').replace(/\s+/g, ' ').slice(0, 120);
const isDenied = res => res.status === 401 || res.status === 403 || (res.json && res.json.code === '42501');
const isMissing = res => res.status === 404;

async function checkReachable() {
  const res = await call('GET', '/rest/v1/seasons?select=id&limit=1');
  if (res.status === 200 && Array.isArray(res.json)) {
    record('PASS', 'Public read works', 'seasons answered');
  } else {
    throw new Unreachable(`public read returned ${res.status}: ${snippet(res)}`);
  }
}

async function checkSignups() {
  const res = await call('GET', '/auth/v1/settings');
  const disabled = res.json && typeof res.json.disable_signup === 'boolean' ? res.json.disable_signup : null;
  if (disabled === null) {
    record('WARN', 'Signups disabled', `could not read the setting (status ${res.status})`);
  } else if (EXPECT.signupsDisabled === null) {
    record('PASS', 'Signups disabled', `not asserted for ${envName}; currently ${disabled}`);
  } else if (disabled === EXPECT.signupsDisabled) {
    record('PASS', 'Signups disabled', `disable_signup is ${disabled}, as expected`);
  } else {
    record('FAIL', 'Signups disabled', `disable_signup is ${disabled}, expected ${EXPECT.signupsDisabled}`);
  }
}

async function checkMfa() {
  const res = await call('POST', '/rest/v1/rpc/admin_mfa_required', {});
  const value = typeof res.json === 'boolean' ? res.json : null;
  if (value === null) {
    const missing = isMissing(res);
    const status = EXPECT.mfaRequired === true ? 'FAIL' : 'WARN';
    record(status, 'Admin MFA required',
      missing ? 'admin_mfa_required() is not installed: run supabase/mfa-migration.sql'
        : `unexpected answer (status ${res.status}): ${snippet(res)}`);
  } else if (EXPECT.mfaRequired === null) {
    record('PASS', 'Admin MFA required', `not asserted for ${envName}; currently ${value}`);
  } else if (value === EXPECT.mfaRequired) {
    record('PASS', 'Admin MFA required', `admin_mfa_required() is ${value}, as expected`);
  } else {
    record('FAIL', 'Admin MFA required', `admin_mfa_required() is ${value}, expected ${EXPECT.mfaRequired}`);
  }
}

async function checkAdminRpcs() {
  for (const [name, body] of ADMIN_RPCS) {
    const res = await call('POST', `/rest/v1/rpc/${name}`, body);
    const label = `Anonymous cannot call ${name}()`;
    if (isDenied(res)) record('PASS', label, `denied (${res.status})`);
    else if (isMissing(res)) record('WARN', label, 'function not found: migration not applied in this project');
    else record('FAIL', label, `status ${res.status}: ${snippet(res)}`);
  }
}

async function checkDirectWrites() {
  for (const [method, path, body] of DIRECT_WRITES) {
    const res = await call(method, path, body);
    const label = `Anonymous cannot ${method} ${path.split('?')[0].replace('/rest/v1/', '')}`;
    if (isDenied(res)) record('PASS', label, `denied (${res.status})`);
    else record('FAIL', label, `status ${res.status}: ${snippet(res)}`);
  }
}

async function checkPrivateReads() {
  for (const table of PRIVATE_TABLES) {
    const res = await call('GET', `/rest/v1/${table}?select=*&limit=1`);
    const label = `Anonymous cannot read ${table}`;
    if (isDenied(res) || isMissing(res)) record('PASS', label, `not readable (${res.status})`);
    else if (res.status === 200 && Array.isArray(res.json) && res.json.length === 0) {
      record('PASS', label, 'readable endpoint but no rows are exposed');
    } else {
      record('FAIL', label, `status ${res.status}: rows may be exposed`);
    }
  }
}

function render() {
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  results.forEach(r => { counts[r.status] += 1; });
  return { counts, results };
}

function markdown({ counts, results: rows }, note) {
  const lines = [
    `## Security drift check: ${envName}`,
    '',
    note || (counts.FAIL ? '**Drift detected.** Fix the failing checks below.' : 'No drift detected.'),
    '',
    `PASS ${counts.PASS} · WARN ${counts.WARN} · FAIL ${counts.FAIL}`,
    '',
    '| Result | Check | Detail |',
    '|---|---|---|'
  ];
  rows.forEach(r => lines.push(`| ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, '/')} |`));
  return lines.join('\n') + '\n';
}

function emit(note, code) {
  const summary = render();
  if (flag('json')) {
    console.log(JSON.stringify({ environment: envName, ...summary, note: note || null, exitCode: code }, null, 2));
  } else {
    console.log(`Security drift check: ${envName} (${base.url})\n`);
    for (const r of results) console.log(`${r.status.padEnd(4)} ${r.name} - ${r.detail}`);
    console.log(`\nPASS ${summary.counts.PASS} · WARN ${summary.counts.WARN} · FAIL ${summary.counts.FAIL}` +
      (note ? `\n${note}` : ''));
  }
  const md = markdown(summary, note);
  const file = option('markdown', '');
  if (file) fs.writeFileSync(file, md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(code);
}

(async () => {
  try {
    await checkReachable();
    await checkSignups();
    await checkMfa();
    await checkAdminRpcs();
    await checkDirectWrites();
    await checkPrivateReads();
  } catch (error) {
    if (error instanceof Unreachable) {
      record('WARN', 'Project reachable', error.message);
      return emit('Inconclusive: the project could not be checked. This is not a drift result.', 2);
    }
    throw error;
  }
  const { counts } = render();
  const drifted = counts.FAIL > 0 || (flag('strict-warnings') && counts.WARN > 0);
  emit(drifted ? 'Drift detected.' : '', drifted ? 1 : 0);
})().catch(error => fail(error && error.message ? error.message : String(error)));
