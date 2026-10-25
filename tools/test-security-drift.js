#!/usr/bin/env node
/*
 * Offline test for tools/check-security-drift.js.
 *
 * Starts a mock Supabase HTTP server, runs the monitor against it and checks the exit
 * code and findings for a healthy project and for each kind of drift. It also checks
 * that the monitor only ever sends the public key and fake ids. No network, no secrets.
 *
 * Usage: node tools/test-security-drift.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'check-security-drift.js');
const KEY = 'sb_publishable_test_key_for_mock_server';
const DENIED = { status: 401, json: { code: '42501', message: 'permission denied' } };

/** What a correctly configured project answers. */
function healthy(method, url) {
  const pathname = url.split('?')[0];
  if (method === 'GET' && pathname === '/rest/v1/seasons') return { status: 200, json: [] };
  if (method === 'GET' && pathname === '/auth/v1/settings') return { status: 200, json: { disable_signup: true } };
  if (method === 'POST' && pathname === '/rest/v1/rpc/admin_mfa_required') return { status: 200, json: true };
  return DENIED;
}

function startServer(override, log) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        log.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
        const reply = (override && override(req.method, req.url, raw)) || healthy(req.method, req.url);
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(reply.json === undefined ? '' : JSON.stringify(reply.json));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function run(port, extraArgs = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, '--json', ...extraArgs], {
      env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_ANON_KEY: KEY, GITHUB_STEP_SUMMARY: '' }
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      let json = null;
      try { json = JSON.parse(out); } catch (error) { /* leave null */ }
      resolve({ code, json, out, err });
    });
  });
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

async function scenario(override, extraArgs) {
  const log = [];
  const server = await startServer(override, log);
  try {
    const result = await run(server.address().port, extraArgs);
    return { ...result, log };
  } finally {
    server.close();
  }
}

const failing = result => result.json.results.filter(r => r.status === 'FAIL').map(r => r.name);
const warning = result => result.json.results.filter(r => r.status === 'WARN').map(r => r.name);

test('healthy project: exit 0, no failures', async () => {
  const r = await scenario(null);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.deepStrictEqual(failing(r), []);
  assert.deepStrictEqual(warning(r), []);
  assert.ok(r.json.counts.PASS >= 25, 'expected the full probe set to run');
});

test('signups enabled is reported as drift', async () => {
  const r = await scenario((m, u) => u === '/auth/v1/settings' ? { status: 200, json: { disable_signup: false } } : null);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(failing(r), ['Signups disabled']);
});

test('admin MFA switched off is reported as drift', async () => {
  const r = await scenario((m, u) => u.endsWith('/rpc/admin_mfa_required') ? { status: 200, json: false } : null);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(failing(r), ['Admin MFA required']);
});

test('admin MFA function missing counts as drift in production', async () => {
  const r = await scenario((m, u) => u.endsWith('/rpc/admin_mfa_required') ? { status: 404, json: { code: 'PGRST202' } } : null);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(failing(r), ['Admin MFA required']);
});

test('an admin RPC that anonymous callers can run is reported', async () => {
  const r = await scenario((m, u) => u.endsWith('/rpc/replace_all_data') ? { status: 200, json: null } : null);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(failing(r), ['Anonymous cannot call replace_all_data()']);
});

test('a direct anonymous write that succeeds is reported', async () => {
  const r = await scenario((m, u) => m === 'POST' && u === '/rest/v1/teams' ? { status: 201 } : null);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(failing(r), ['Anonymous cannot POST teams']);
});

test('exposed private rows are reported', async () => {
  const r = await scenario((m, u) => m === 'GET' && u.startsWith('/rest/v1/profiles') ? { status: 200, json: [{ email: 'a@b.c' }] } : null);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(failing(r), ['Anonymous cannot read profiles']);
});

test('a function missing from the project is a warning, not drift', async () => {
  const override = (m, u) => u.endsWith('/rpc/delete_team') ? { status: 404, json: { code: 'PGRST202' } } : null;
  const r = await scenario(override);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(warning(r), ['Anonymous cannot call delete_team()']);
  const strict = await scenario(override, ['--strict-warnings']);
  assert.strictEqual(strict.code, 1);
});

test('a paused or failing project is inconclusive (exit 2), not drift', async () => {
  const r = await scenario((m, u) => u.startsWith('/rest/v1/seasons') ? { status: 503, json: {} } : null);
  assert.strictEqual(r.code, 2);
  assert.deepStrictEqual(failing(r), []);
});

test('an unreachable host is inconclusive (exit 2)', async () => {
  const server = await startServer(null, []);
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const r = await run(port);
  assert.strictEqual(r.code, 2, r.out + r.err);
});

test('development does not assert signups or MFA by default', async () => {
  const override = (m, u) => {
    if (u === '/auth/v1/settings') return { status: 200, json: { disable_signup: false } };
    if (u.endsWith('/rpc/admin_mfa_required')) return { status: 200, json: false };
    return null;
  };
  const dev = await scenario(override, ['--env=dev']);
  assert.strictEqual(dev.code, 0, dev.out + dev.err);
  const forced = await scenario(override, ['--env=dev', '--expect-signups-disabled=true']);
  assert.strictEqual(forced.code, 1);
});

test('writes a markdown report', async () => {
  const file = path.join(os.tmpdir(), `drift-report-${process.pid}.md`);
  const r = await scenario(null, ['--markdown=' + file]);
  assert.strictEqual(r.code, 0);
  const text = fs.readFileSync(file, 'utf8');
  fs.unlinkSync(file);
  assert.ok(text.includes('No drift detected.') && text.includes('| PASS |'));
});

test('safety: only the public key and fake ids are ever sent', async () => {
  const r = await scenario(null);
  assert.strictEqual(r.code, 0);
  const allowedBodiesWithoutProbeId = new Set([
    '{}', '{"p_limit":1}', '{"p_required":true}'
  ]);
  for (const req of r.log) {
    assert.strictEqual(req.headers.apikey, KEY);
    assert.strictEqual(req.headers.authorization, 'Bearer ' + KEY);
    assert.ok(!/service_role|sb_secret/i.test(JSON.stringify(req)), 'no privileged key may be sent');
    if (req.method === 'GET') continue;
    const target = req.url + ' ' + req.body;
    const isProbe = target.includes('__drift_probe__');
    const isKnownSafe = req.url.endsWith('/rpc/admin_mfa_required') || allowedBodiesWithoutProbeId.has(req.body);
    assert.ok(isProbe || isKnownSafe, `non-fake mutation sent: ${req.method} ${req.url} ${req.body}`);
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log('ok   ' + name);
    } catch (error) {
      failed += 1;
      console.log('FAIL ' + name + '\n     ' + String(error.message).split('\n').join('\n     '));
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
