#!/usr/bin/env node
'use strict';

// Keep the CRAP ceiling on a one-way ratchet: decreases are allowed,
// increases are not. The pre-commit hook checks the STAGED package.json;
// `npm run crap` uses --worktree so CI gets the same absolute ceiling.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const LIMIT = 16;

function readThreshold(source, label) {
  const pkg = JSON.parse(source);
  const command = pkg.scripts && pkg.scripts.crap;
  const match = command && command.match(/--threshold\s+(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(label + ': crap command has no numeric --threshold');
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(label + ': invalid CRAP threshold ' + match[1]);
  }
  return value;
}

function gitShow(revision) {
  return execFileSync('git', ['show', revision], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  const worktree = process.argv.includes('--worktree');
  const current = readThreshold(
    worktree ? fs.readFileSync('package.json', 'utf8') : gitShow(':package.json'),
    worktree ? 'worktree' : 'staged',
  );
  const previous = readThreshold(gitShow('HEAD:package.json'), 'HEAD');
  if (current > LIMIT) {
    throw new Error('CRAP threshold ' + current + ' exceeds the permanent ceiling ' + LIMIT);
  }
  if (current > previous) {
    throw new Error('CRAP threshold must not increase: ' + previous + ' -> ' + current +
      ' (lower it or keep ' + previous + ')');
  }
  console.log('CRAP ratchet OK: ' + current + ' (HEAD ' + previous + ', ceiling ' + LIMIT + ')');
}

try {
  main();
} catch (error) {
  console.error('CRAP ratchet failed: ' + error.message);
  process.exitCode = 1;
}
