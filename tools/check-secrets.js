#!/usr/bin/env node
/*
 * Fail CI if a privileged secret is committed to the repository.
 *
 * Supabase publishable/anon keys are intentionally public. Service-role
 * keys, secret keys, private keys and password-bearing database URLs are not.
 * Documentation files are skipped so they can explain these rules safely.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', '.idea', '.vscode', 'node_modules', 'backups', 'dist', 'coverage']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.json', '.sql', '.yml', '.yaml',
  '.html', '.css', '.toml', '.env', '.txt', '.xml', '.svg'
]);

const RULES = [
  {
    name: 'Supabase secret key',
    pattern: /sb_secret_[A-Za-z0-9_-]{16,}/g
  },
  {
    name: 'Supabase service-role variable',
    pattern: /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"]?[A-Za-z0-9._-]{16,}/g
  },
  {
    name: 'Private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
  },
  {
    name: 'Database URL containing a password',
    pattern: /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/g
  }
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;
    if (entry.name.endsWith('.md')) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    out.push({ full, rel });
  }
  return out;
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
}

const findings = [];

for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file.full, 'utf8');

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      findings.push({ file: file.rel, line: lineNumber(text, match.index), rule: rule.name });
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }

  // Legacy Supabase keys are JWTs. An anon JWT is public; a service_role JWT is not.
  const jwtPattern = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  let jwt;
  while ((jwt = jwtPattern.exec(text)) !== null) {
    const payload = decodeJwtPayload(jwt[0]);
    if (payload && payload.role === 'service_role') {
      findings.push({ file: file.rel, line: lineNumber(text, jwt.index), rule: 'JWT with service_role claim' });
    }
  }
}

if (findings.length) {
  console.error('Potential secrets found:');
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} - ${finding.rule}`);
  }
  process.exit(1);
}

console.log('No privileged secrets found in tracked source files.');
