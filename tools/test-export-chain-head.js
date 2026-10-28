#!/usr/bin/env node
/*
 * Tests the public audit-chain head probe used by the daily backup.
 *
 * Usage: npm run test:export-chain-head
 *
 * A local HTTP server stands in for PostgREST so the probe is tested without
 * touching a hosted project. The backup must keep working when roadmap D is
 * not installed, and must never turn a malformed head into backup metadata.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { readChainHead } = require('./export-backup');

const KEY = 'sb_publishable_test_key';
const HEAD = {
  count: 42,
  lastId: 1234,
  at: '2026-10-28T06:15:00+00:00',
  head: 'a'.repeat(64)
};

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function withServer(mode, run) {
  const requests = [];
  const { server, url } = await startServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (mode === 'missing') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"message":"Not found"}');
        return;
      }
      if (mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"message":"boom"}');
        return;
      }
      if (mode === 'invalid') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"count":"42","head":null}');
        return;
      }
      if (mode === 'empty') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"count":0,"lastId":null,"at":null,"head":null}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(HEAD));
    });
  });

  try {
    return await run(url, requests);
  } finally {
    await close(server);
  }
}

(async () => {
  // ------------------------------------------------------------
  // 1. A project with the chain returns its head
  // ------------------------------------------------------------
  const head = await withServer('ok', async (url, requests) => {
    const value = await readChainHead({ url, key: KEY });
    assert(value, 'the head is returned');
    assert.strictEqual(value.count, HEAD.count);
    assert.strictEqual(value.lastId, HEAD.lastId);
    assert.strictEqual(value.at, HEAD.at);
    assert.strictEqual(value.head, HEAD.head);
    assert(!Number.isNaN(Date.parse(value.readAt)), 'readAt is an ISO timestamp');

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, 'POST');
    assert.strictEqual(requests[0].url, '/rest/v1/rpc/audit_chain_head');
    assert.strictEqual(requests[0].headers.apikey, KEY);
    assert.strictEqual(requests[0].headers.authorization, `Bearer ${KEY}`);
    assert.strictEqual(requests[0].body, '{}');
    return value;
  });
  assert.strictEqual(head.count, HEAD.count);
  console.log('OK a project with the chain publishes count, last id, time and head');

  // ------------------------------------------------------------
  // 2. A project without roadmap D, an error or a bad shape is skipped
  // ------------------------------------------------------------
  for (const mode of ['missing', 'error', 'invalid']) {
    const value = await withServer(mode, url => readChainHead({ url, key: KEY }));
    assert.strictEqual(value, null, `${mode}: the backup continues without a head`);
  }

  // An empty log is a valid head: count 0 and a null hash.
  const empty = await withServer('empty', url => readChainHead({ url, key: KEY }));
  assert(empty, 'an empty chain still records its count');
  assert.strictEqual(empty.count, 0);
  assert.strictEqual(empty.head, null);
  assert(!Number.isNaN(Date.parse(empty.readAt)), 'readAt is set for an empty chain');
  console.log('OK a missing, failing or malformed head never blocks the backup, and an empty chain is recorded');

  console.log('\nAll audit chain probe checks passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
