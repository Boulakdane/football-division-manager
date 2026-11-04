#!/usr/bin/env node
/*
 * Fail CI when a GitHub Actions step uses a mutable tag or branch instead of a
 * commit SHA. A tag can be moved to another commit by its owner, so a pinned
 * SHA plus a `# vX.Y.Z` comment is the only reproducible form; Dependabot reads
 * that comment and keeps the pin current.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const ACTIONS = path.join(ROOT, '.github', 'actions');
const USES = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const VERSION = /^v?\d+\.\d+\.\d+/;

function yamlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yamlFiles(full, out);
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const findings = [];
let checked = 0;

for (const file of [...yamlFiles(WORKFLOWS), ...yamlFiles(ACTIONS)]) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = USES.exec(line);
    if (!match) return;

    const target = match[1];
    // Local composite actions and container actions are not tag references.
    if (target.startsWith('./') || target.startsWith('docker://')) return;

    checked += 1;
    const at = target.lastIndexOf('@');
    const ref = at === -1 ? '' : target.slice(at + 1);

    if (!SHA.test(ref)) {
      findings.push({ file: rel, line: index + 1, target, reason: 'not pinned to a commit SHA' });
    } else if (!match[2] || !VERSION.test(match[2])) {
      findings.push({ file: rel, line: index + 1, target, reason: 'missing # vX.Y.Z comment for Dependabot' });
    }
  });
}

if (findings.length) {
  console.error('GitHub Actions must be pinned to commit SHAs with a version comment:');
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} - ${finding.target} (${finding.reason})`);
  }
  process.exit(1);
}

console.log(`All ${checked} GitHub Actions uses are pinned to commit SHAs.`);
