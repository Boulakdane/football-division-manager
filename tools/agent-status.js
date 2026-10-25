#!/usr/bin/env node
/*
 * Show which branches are in flight, who owns them and which files they touch,
 * so Claude, opencode and the maintainer can avoid editing the same thing.
 *
 * Usage:
 *   npm run agents:status                 # fetch, then report
 *   node tools/agent-status.js --no-fetch # use what is already fetched
 *   node tools/agent-status.js --strict   # exit 1 if two branches touch the same hot file
 *   node tools/agent-status.js --include-bots  # count Dependabot branches in the overlap check
 *   node tools/agent-status.js --base=origin/main
 *
 * Read-only: it only runs `git fetch` (unless --no-fetch) and read commands.
 * Rules this supports: docs/COORDINATION.md
 */
'use strict';

const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const option = (name, fallback) => {
  const hit = args.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = option('base', 'origin/main');

// Keep in sync with the "Hot files" table in docs/COORDINATION.md.
const HOT_FILES = new Set([
  'js/app.js',
  'js/i18n.js',
  'supabase/schema.sql',
  'css/tailwind.css',
  'package-lock.json',
  'docs/PROGRESS.md',
  'docs/TASKS.md',
  'docs/MODERNIZATION_PLAN.md'
]);

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(...gitArgs) {
  try { return git(...gitArgs); } catch (error) { return null; }
}

function ownerOf(branch) {
  const prefix = branch.replace(/^origin\//, '').split('/')[0];
  if (['claude', 'opencode', 'maintainer'].includes(prefix)) return prefix;
  if (prefix === 'dependabot') return 'dependabot';
  return 'other';
}

function main() {
  if (!tryGit('rev-parse', '--git-dir')) {
    console.error('Run this inside the repository.');
    process.exit(2);
  }

  if (!flag('no-fetch')) {
    // Explicit refspec: shallow or single-branch clones (common in AI sandboxes) would
    // otherwise never download the other tools' branches.
    if (tryGit('fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*') === null) {
      console.warn('warning: could not fetch origin; showing what is already local.\n');
    }
  }

  if (tryGit('rev-parse', '--verify', BASE) === null) {
    console.error(`Base ${BASE} not found. Fetch first or pass --base=<ref>.`);
    process.exit(2);
  }

  const refs = git('for-each-ref', '--format=%(refname:short)\t%(committerdate:short)\t%(authorname)\t%(subject)', 'refs/remotes/origin')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, date, author, subject] = line.split('\t');
      return { name, date, author, subject };
    })
    .filter(ref => ref.name !== 'origin' && !/^origin\/(HEAD|main|master)$/.test(ref.name) && ref.name !== BASE);

  const branches = [];
  for (const ref of refs) {
    const ahead = Number(tryGit('rev-list', '--count', `${BASE}..${ref.name}`) || 0);
    if (ahead === 0) continue; // already merged: not in flight

    let files = tryGit('diff', '--name-only', `${BASE}...${ref.name}`);
    let approximate = false;
    if (files === null) { // shallow clone without a merge base
      files = tryGit('diff', '--name-only', BASE, ref.name) || '';
      approximate = true;
    }
    branches.push({
      ...ref,
      owner: ownerOf(ref.name),
      ahead,
      approximate,
      files: files.split('\n').filter(Boolean)
    });
  }

  console.log(`Base: ${BASE} (${git('rev-parse', '--short', BASE)})`);
  console.log(`In-flight branches: ${branches.length}\n`);

  const order = ['claude', 'opencode', 'maintainer', 'other', 'dependabot'];
  branches.sort((a, b) => order.indexOf(a.owner) - order.indexOf(b.owner) || a.name.localeCompare(b.name));

  for (const branch of branches) {
    const hot = branch.files.filter(file => HOT_FILES.has(file));
    console.log(`[${branch.owner}] ${branch.name}`);
    console.log(`  ${branch.ahead} commit(s) ahead, last ${branch.date} by ${branch.author}`);
    console.log(`  ${branch.subject}`);
    console.log(`  files: ${branch.files.length}${branch.approximate ? ' (approximate: no merge base)' : ''}` +
      (hot.length ? `  | hot: ${hot.join(', ')}` : ''));
    console.log('');
  }

  // Overlaps: any file touched by two or more branches, hot files first.
  const touched = new Map();
  // Bots rebase their own branches, so they are listed but not counted as overlaps by default.
  const considered = branches.filter(branch => flag('include-bots') || branch.owner !== 'dependabot');
  for (const branch of considered) {
    for (const file of branch.files) {
      if (!touched.has(file)) touched.set(file, []);
      touched.get(file).push(branch.name.replace(/^origin\//, ''));
    }
  }
  const overlaps = [...touched.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort(([a], [b]) => Number(HOT_FILES.has(b)) - Number(HOT_FILES.has(a)) || a.localeCompare(b));

  if (!overlaps.length) {
    console.log('No file is touched by more than one in-flight branch.');
    return;
  }

  console.log('Files touched by more than one branch (coordinate before editing):');
  let hotConflicts = 0;
  for (const [file, owners] of overlaps) {
    const isHot = HOT_FILES.has(file);
    if (isHot) hotConflicts += 1;
    console.log(`  ${isHot ? 'HOT ' : '    '}${file}  <-  ${owners.join(', ')}`);
  }
  if (flag('strict') && hotConflicts) process.exit(1);
}

main();
