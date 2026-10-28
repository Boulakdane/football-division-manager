#!/usr/bin/env node
/*
 * Encrypt and decrypt a KickOff Division JSON backup.
 *
 * Usage:
 *   node tools/backup-crypt.js encrypt backup.json backup.kob
 *   node tools/backup-crypt.js decrypt backup.kob backup.json
 *
 * The passphrase is read from KICKOFF_BACKUP_PASSPHRASE and never from the
 * command line, so it does not end up in shell history or process listings.
 *
 * Format: a JSON envelope holding a scrypt salt and an AES-256-GCM nonce,
 * authentication tag and ciphertext (base64). The envelope header is used as
 * additional authenticated data, so editing the salt, nonce, size or checksum
 * makes decryption fail instead of producing different plaintext.
 *
 * This is a secret worth protecting: losing the passphrase makes every backup
 * unreadable. Store it in a password manager as well as in the repository
 * secret used by the daily workflow.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMAT = 'kickoff-backup-encrypted';
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT = { n: 32768, r: 8, p: 1 };
const MAX_MEM = 96 * 1024 * 1024;

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

function passphraseFromEnv() {
  const value = process.env.KICKOFF_BACKUP_PASSPHRASE;
  if (!value || !value.trim()) {
    fail('KICKOFF_BACKUP_PASSPHRASE is not set; refusing to ' + (process.argv[2] === 'decrypt' ? 'decrypt' : 'encrypt') + '.');
  }
  return value;
}

function deriveKey(passphrase, salt, params) {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM
  });
}

/** The header fields bound to the ciphertext as additional authenticated data. */
function header(envelope) {
  return {
    format: envelope.format,
    version: envelope.version,
    createdAt: envelope.createdAt,
    kdf: envelope.kdf,
    cipher: { name: envelope.cipher.name, iv: envelope.cipher.iv },
    plaintext: envelope.plaintext
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Encrypt a Buffer and return the JSON envelope as a string.
 *
 * `options.name` is the original file name, recorded so a restored backup can
 * be checked against the name the workflow published.
 */
function encryptBuffer(plaintext, passphrase, options = {}) {
  if (!Buffer.isBuffer(plaintext)) throw new TypeError('plaintext must be a Buffer');
  if (!passphrase) throw new Error('A passphrase is required');

  const params = { ...SCRYPT, ...(options.scrypt || {}) };
  const salt = options.salt || crypto.randomBytes(SALT_BYTES);
  const iv = options.iv || crypto.randomBytes(IV_BYTES);
  if (salt.length < SALT_BYTES) throw new Error('The salt must be at least 16 bytes');
  if (iv.length !== IV_BYTES) throw new Error('The nonce must be 12 bytes');

  const envelope = {
    format: FORMAT,
    version: VERSION,
    createdAt: (options.createdAt || new Date()).toISOString(),
    kdf: {
      name: 'scrypt',
      n: params.n,
      r: params.r,
      p: params.p,
      salt: salt.toString('base64')
    },
    cipher: {
      name: 'aes-256-gcm',
      iv: iv.toString('base64')
    },
    plaintext: {
      name: options.name || 'backup.json',
      bytes: plaintext.length,
      sha256: sha256(plaintext)
    },
    data: ''
  };

  const key = deriveKey(passphrase, salt, params);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header(envelope)), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  envelope.cipher.tag = cipher.getAuthTag().toString('base64');
  envelope.data = ciphertext.toString('base64');

  return JSON.stringify(envelope, null, 2) + '\n';
}

function readEnvelope(input) {
  let envelope;
  try {
    envelope = JSON.parse(input);
  } catch (error) {
    throw new Error(`Not a KickOff backup envelope: ${error.message}`);
  }
  if (!envelope || envelope.format !== FORMAT) {
    throw new Error(`Not a KickOff backup envelope (format ${JSON.stringify(envelope && envelope.format)})`);
  }
  if (envelope.version !== VERSION) {
    throw new Error(`Unsupported backup envelope version ${envelope.version}`);
  }
  if (!envelope.kdf || envelope.kdf.name !== 'scrypt') {
    throw new Error('Unsupported key derivation function');
  }
  if (!envelope.cipher || envelope.cipher.name !== 'aes-256-gcm') {
    throw new Error('Unsupported cipher');
  }
  const { n, r, p } = envelope.kdf;
  if (!Number.isInteger(n) || n < 16384 || n > 1048576 ||
      !Number.isInteger(r) || r < 1 || r > 16 ||
      !Number.isInteger(p) || p < 1 || p > 4) {
    throw new Error('Unsupported scrypt parameters');
  }
  if (typeof envelope.data !== 'string' ||
      !envelope.plaintext || typeof envelope.plaintext !== 'object' ||
      typeof envelope.plaintext.sha256 !== 'string' ||
      !Number.isInteger(envelope.plaintext.bytes) ||
      typeof envelope.cipher.tag !== 'string') {
    throw new Error('The envelope is incomplete');
  }
  return envelope;
}

/** Decrypt a JSON envelope and return the plaintext Buffer. */
function decryptBuffer(input, passphrase) {
  if (!passphrase) throw new Error('A passphrase is required');
  const envelope = readEnvelope(input);

  const salt = Buffer.from(envelope.kdf.salt, 'base64');
  const iv = Buffer.from(envelope.cipher.iv, 'base64');
  const tag = Buffer.from(envelope.cipher.tag, 'base64');
  if (salt.length < 16 || salt.length > 64) throw new Error('The envelope salt is invalid');
  if (iv.length !== IV_BYTES) throw new Error('The envelope nonce is invalid');
  if (tag.length !== TAG_BYTES) throw new Error('The envelope authentication tag is invalid');

  const key = deriveKey(passphrase, salt, envelope.kdf);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(JSON.stringify(header(envelope)), 'utf8'));
  decipher.setAuthTag(tag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  } catch (error) {
    throw new Error('Decryption failed: wrong passphrase or modified backup');
  }

  if (plaintext.length !== envelope.plaintext.bytes) {
    throw new Error('Decryption failed: the plaintext size does not match the envelope');
  }
  if (sha256(plaintext) !== envelope.plaintext.sha256) {
    throw new Error('Decryption failed: the plaintext checksum does not match the envelope');
  }
  return plaintext;
}

function main() {
  const [command, input, output] = process.argv.slice(2);
  if (!['encrypt', 'decrypt'].includes(command) || !input || !output) {
    fail('Usage: node tools/backup-crypt.js <encrypt|decrypt> <input> <output>');
  }
  if (path.resolve(input) === path.resolve(output)) {
    fail('Input and output must be different files');
  }
  if (!fs.existsSync(input)) fail(`Input not found: ${input}`);

  const passphrase = passphraseFromEnv();
  const source = fs.readFileSync(input);

  if (command === 'encrypt') {
    const envelope = encryptBuffer(source, passphrase, { name: path.basename(input) });
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, envelope, 'utf8');
    console.log(`Encrypted ${input} (${source.length} bytes) -> ${output}`);
    console.log(`SHA-256 (plaintext): ${sha256(source)}`);
    return;
  }

  const plaintext = decryptBuffer(source.toString('utf8'), passphrase);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, plaintext);
  console.log(`Decrypted ${input} -> ${output} (${plaintext.length} bytes)`);
  console.log(`SHA-256 (plaintext): ${sha256(plaintext)}`);
}

module.exports = { encryptBuffer, decryptBuffer, readEnvelope, sha256, FORMAT };

if (require.main === module) main();
