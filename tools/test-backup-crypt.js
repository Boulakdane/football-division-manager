#!/usr/bin/env node
/*
 * Tests for tools/backup-crypt.js.
 *
 * Usage: npm run test:backup-crypt
 *
 * Proves that the round trip is byte-exact, that a wrong passphrase, an edited
 * ciphertext or edited metadata all fail closed, that the envelope does not
 * leak the plaintext, and that the CLI refuses to run without the secret.
 */

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encryptBuffer, decryptBuffer, sha256 } = require('./backup-crypt');

const TOOL = path.join(__dirname, 'backup-crypt.js');
const PASSPHRASE = 'correct horse battery staple';
const PLAINTEXT = Buffer.from(JSON.stringify({
  seasons: [{ id: 's1', name: 'Test season' }],
  teams: [{ id: 't1', name: 'Secret FC' }],
  marker: 'PLAINTEXT-ONLY-MARKER'
}, null, 2) + '\n', 'utf8');

function expectFailure(fn, pattern, label) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert(error, `${label}: expected a failure`);
  assert(pattern.test(String(error.message || error)), `${label}: unexpected message ${error.message}`);
}

function runCli(args, env) {
  return execFileSync(process.execPath, [TOOL, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-crypt-'));

try {
  // ------------------------------------------------------------
  // 1. Round trip keeps every byte
  // ------------------------------------------------------------
  const envelope = encryptBuffer(PLAINTEXT, PASSPHRASE, { name: 'backup.json' });
  const parsed = JSON.parse(envelope);

  assert.strictEqual(parsed.format, 'kickoff-backup-encrypted');
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.kdf.name, 'scrypt');
  assert.strictEqual(parsed.kdf.n, 32768);
  assert.strictEqual(parsed.cipher.name, 'aes-256-gcm');
  assert.strictEqual(parsed.plaintext.name, 'backup.json');
  assert.strictEqual(parsed.plaintext.bytes, PLAINTEXT.length);
  assert.strictEqual(parsed.plaintext.sha256, sha256(PLAINTEXT));

  const restored = decryptBuffer(envelope, PASSPHRASE);
  assert(restored.equals(PLAINTEXT), 'the decrypted bytes match the source');
  assert.strictEqual(JSON.parse(restored.toString('utf8')).teams[0].name, 'Secret FC');
  console.log('OK encryption round trip is byte-exact');

  // The plaintext must not appear in the envelope.
  assert(!Buffer.from(envelope).includes(Buffer.from('PLAINTEXT-ONLY-MARKER')), 'the envelope does not leak plaintext');
  console.log('OK the envelope does not contain the plaintext');

  // A fresh salt and nonce make two envelopes of the same input differ.
  assert.notStrictEqual(encryptBuffer(PLAINTEXT, PASSPHRASE), envelope);
  console.log('OK every envelope uses a fresh salt and nonce');

  // ------------------------------------------------------------
  // 2. Wrong secrets and edited data fail closed
  // ------------------------------------------------------------
  expectFailure(() => decryptBuffer(envelope, 'wrong passphrase'), /wrong passphrase or modified backup/i, 'wrong passphrase');
  expectFailure(() => decryptBuffer(envelope, ''), /passphrase/i, 'empty passphrase');

  const tamperedData = JSON.parse(envelope);
  const bytes = Buffer.from(tamperedData.data, 'base64');
  bytes[bytes.length - 1] ^= 0x01;
  tamperedData.data = bytes.toString('base64');
  expectFailure(() => decryptBuffer(JSON.stringify(tamperedData), PASSPHRASE), /modified backup/i, 'edited ciphertext');

  const tamperedSize = JSON.parse(envelope);
  tamperedSize.plaintext.bytes += 1;
  expectFailure(() => decryptBuffer(JSON.stringify(tamperedSize), PASSPHRASE), /modified backup/i, 'edited size');

  const tamperedHash = JSON.parse(envelope);
  tamperedHash.plaintext.sha256 = '0'.repeat(64);
  expectFailure(() => decryptBuffer(JSON.stringify(tamperedHash), PASSPHRASE), /modified backup/i, 'edited checksum');

  const tamperedName = JSON.parse(envelope);
  tamperedName.plaintext.name = 'other.json';
  expectFailure(() => decryptBuffer(JSON.stringify(tamperedName), PASSPHRASE), /modified backup/i, 'edited file name');

  const tamperedIv = JSON.parse(envelope);
  tamperedIv.cipher.iv = Buffer.alloc(12, 7).toString('base64');
  expectFailure(() => decryptBuffer(JSON.stringify(tamperedIv), PASSPHRASE), /modified backup/i, 'edited nonce');

  const tamperedSalt = JSON.parse(envelope);
  tamperedSalt.kdf.salt = Buffer.alloc(16, 3).toString('base64');
  expectFailure(() => decryptBuffer(JSON.stringify(tamperedSalt), PASSPHRASE), /wrong passphrase or modified backup/i, 'edited salt');
  console.log('OK wrong passphrases and edited envelopes are rejected');

  expectFailure(() => decryptBuffer(JSON.stringify({ hello: 'world' }), PASSPHRASE), /not a kickoff backup envelope/i, 'foreign JSON');
  expectFailure(() => decryptBuffer(JSON.stringify({ ...parsed, version: 2 }), PASSPHRASE), /unsupported .*version/i, 'future version');
  expectFailure(() => decryptBuffer(JSON.stringify({ ...parsed, kdf: { ...parsed.kdf, n: 2 } }), PASSPHRASE), /scrypt/i, 'weak scrypt parameters');
  expectFailure(() => decryptBuffer(JSON.stringify({ ...parsed, plaintext: undefined }), PASSPHRASE), /incomplete/i, 'missing plaintext metadata');
  expectFailure(() => decryptBuffer(JSON.stringify({ ...parsed, cipher: { ...parsed.cipher, tag: undefined } }), PASSPHRASE), /incomplete/i, 'missing authentication tag');
  expectFailure(() => decryptBuffer('not json', PASSPHRASE), /not a kickoff backup envelope/i, 'invalid JSON');
  console.log('OK malformed envelopes are rejected');

  // ------------------------------------------------------------
  // 3. The CLI reads the passphrase only from the environment
  // ------------------------------------------------------------
  const source = path.join(tmp, 'backup.json');
  const encrypted = path.join(tmp, 'backup.kob');
  const decrypted = path.join(tmp, 'restored.json');
  fs.writeFileSync(source, PLAINTEXT);

  const envWithoutSecret = { ...process.env };
  delete envWithoutSecret.KICKOFF_BACKUP_PASSPHRASE;
  let missing = null;
  try {
    execFileSync(process.execPath, [TOOL, 'encrypt', source, encrypted], { env: envWithoutSecret, stdio: 'pipe' });
  } catch (err) {
    missing = err;
  }
  assert(missing, 'encrypt without a passphrase must fail');
  assert.notStrictEqual(missing.status, 0);
  assert(!fs.existsSync(encrypted), 'a failed encryption writes nothing');
  console.log('OK the CLI fails closed without the passphrase secret');

  runCli(['encrypt', source, encrypted], { KICKOFF_BACKUP_PASSPHRASE: PASSPHRASE });
  assert(fs.existsSync(encrypted), 'the CLI writes the envelope');
  assert(!fs.readFileSync(encrypted, 'utf8').includes('Secret FC'), 'the encrypted file does not leak data');

  runCli(['decrypt', encrypted, decrypted], { KICKOFF_BACKUP_PASSPHRASE: PASSPHRASE });
  assert(fs.readFileSync(decrypted).equals(PLAINTEXT), 'the CLI round trip is byte-exact');

  const wrongTarget = path.join(tmp, 'wrong.json');
  let wrong = null;
  try {
    runCli(['decrypt', encrypted, wrongTarget], { KICKOFF_BACKUP_PASSPHRASE: 'not the passphrase' });
  } catch (err) {
    wrong = err;
  }
  assert(wrong, 'decrypt with the wrong passphrase must fail');
  assert.notStrictEqual(wrong.status, 0);
  assert(!fs.existsSync(wrongTarget), 'a failed decryption writes nothing');
  console.log('OK the CLI round trip works and a wrong passphrase writes nothing');

  console.log('\nAll backup encryption checks passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
