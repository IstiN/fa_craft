#!/usr/bin/env node
'use strict';
// AC2 goldens: capture the seven required fa-craft widget states with the
// js_widget_runtime production renderer (the `jsr_widget` CLI, package
// js_widget_runtime 0.4.126) into test/golden/<state>.png.
//
//   node tools/goldens.js            # capture all states + print sha256
//   node tools/goldens.js verify     # drive each state headlessly, assert state
//
// Requirements on PATH: node, dart, flutter (>=3.47), clang (QuickJS bridge
// build once). Overrides: JSR_FLUTTER, JSR_DART, JSR_RUNTIME_DIR, PUB_CACHE.
// The same frozen clock (--freeze-clock -> Date.now 1760000000000) and the
// deterministic world/event log make every capture byte-identical across runs.

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test', 'golden');
const BUILD_DIR = path.join(ROOT, '.goldens-build', 'fa-craft');
const JSR_PACKAGE = 'js_widget_runtime';
const JSR_VERSION = '0.4.126';
const WIDTH = '420';
const HEIGHT = '860';

// --freeze-clock pins Date.now to 1760000000000, so a first-run world seeds
// from 1760000000000 & 0x7fffffff = 1210892288. The cells below are pinned by
// worldgen determinism for that seed: spawn column (0,*,0) is grass at y=33,
// dirt 32..30, stone 29+ (and seed 777 has stone at (0,19,0)).
const FROZEN_SEED = 1210892288;
const STONE_CELLS = [[0, 29, 0], [0, 28, 0], [0, 27, 0], [0, 26, 0]];

const STORAGE_KEY = 'fa-craft:world:v1';
const savePayload = (seed, dayTime, log, player) =>
  JSON.stringify(Object.assign({ v: 1, seed, dayTime, log }, player ? { player } : {}));
const storageOpt = (payload) => ['--storage', JSON.stringify({ [STORAGE_KEY]: payload })];
const ev = (id, payload) => JSON.stringify(payload === undefined ? { id } : { id, payload });
// LOOK_SENS is 0.004 rad/px: 388 px down = -1.552 rad, clamped to pitch max.
const LOOK_DOWN = ev('look', { dx: 0, dy: 388 });

const STATES = [
  {
    name: 'first-run',
    expect: { mode: 'survival', health: 20, dead: false, dayTime: 0, edits: 0, hint: true },
  },
  {
    name: 'block-targeted',
    events: [LOOK_DOWN],
    expect: { health: 20, dead: false, edits: 0 },
  },
  {
    // Target the ground, break grass + dirt, select the dirt slot, place it back.
    name: 'block-placed',
    events: [LOOK_DOWN, ev('break'), ev('break'), ev('hotbar', { slot: 2 }), ev('place')],
    expect: { selected: 2, edits: 3, inventory: { "1": 1, "2": 0 } }, // 1=grass 2=dirt
  },
  {
    name: 'hotbar-switch',
    events: [ev('hotbar', { slot: 5 })],
    expect: { selected: 5 },
  },
  {
    // Stone for the bricks recipe comes from replayed break ops (I3 event log).
    name: 'crafting-crafted',
    storage: savePayload(FROZEN_SEED, 0, STONE_CELLS.map(([x, y, z]) => ({ t: 'set', x, y, z, b: 0 }))),
    events: [ev('craft'), ev('craftRecipe', { id: 'bricks' })],
    expect: { craftOpen: true, notice: 'Crafted bricks.', inventory: { "3": 0, "8": 4 } }, // 3=stone 8=bricks
  },
  {
    // Fall damage (6 half-hearts) reaches the world through log replay.
    name: 'health-change',
    storage: savePayload(FROZEN_SEED, 0, [{ t: 'damage', cause: 'fall', n: 6 }]),
    expect: { health: 14, dead: false },
  },
  {
    // A played world: two bricks placed, one stone banked, evening clock,
    // player moved + turned — all restored from storage on boot.
    name: 'saved-reload',
    storage: savePayload(777, 150, [
      { t: 'set', x: 5, y: 25, z: 5, b: 8 },
      { t: 'set', x: 6, y: 25, z: 5, b: 8 },
      { t: 'set', x: 0, y: 19, z: 0, b: 0 },
    ], { x: 8.5, y: 26.01, z: 8.5, yaw: 2.1, pitch: -0.35 }),
    expect: { dayTime: 150, edits: 3, health: 20, pos: { x: 8.5, y: 26.01, z: 8.5 } },
  },
];

function flutter() { return process.env.JSR_FLUTTER || 'flutter'; }
function dart() { return process.env.JSR_DART || 'dart'; }

// Build the CLI target: the real game sources bundled exactly the way the
// runtime inlines them (test/harness.js mirrors that inliner), plus manifest.
// The generated widget.js gets ONE appended adapter: the HUD's listView root
// (SKILL.md §5b contract) hands the production renderer unbounded sliver
// height and the full-bleed viewport fill crashes on it — an upstream widget
// bug, worked around HERE (not in game/*) by unwrapping single-child
// listView nodes (fa_craft only ever uses one, as its scrollable root)
// before the tree reaches the renderer. Disclosed in the goldens PR body.
const RENDER_ADAPTER = `
(function() {
  var origRender = jsr.render;
  function unwrap(node) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'listView' && Array.isArray(node.children) && node.children.length === 1) {
      return unwrap(node.children[0]);
    }
    if (Array.isArray(node.children)) node.children = node.children.map(unwrap);
    if (node.child) node.child = unwrap(node.child);
    return node;
  }
  jsr.render = function(tree) { origRender(unwrap(tree)); };
})();
`;

function buildWidgetDir() {
  const harness = require(path.join(ROOT, 'test', 'harness.js'));
  fs.rmSync(path.dirname(BUILD_DIR), { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(path.join(BUILD_DIR, 'widget.js'),
    harness.gameSourceText() + RENDER_ADAPTER);
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(BUILD_DIR, 'manifest.json'));
}

// Resolve (or fetch) the js_widget_runtime package checkout that ships the
// `bin/jsr_widget.dart` CLI. JSR_RUNTIME_DIR wins; otherwise download the
// published archive for JSR_VERSION into a temp dir and `flutter pub get` it.
function jsrRuntimeDir() {
  if (process.env.JSR_RUNTIME_DIR) return process.env.JSR_RUNTIME_DIR;
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-craft-jsr-')), 'pkg');
  const tgz = path.join(os.tmpdir(), `${JSR_PACKAGE}-${JSR_VERSION}.tgz`);
  if (!fs.existsSync(tgz)) {
    execFileSync('curl', ['-sL', '-o', tgz,
      `https://pub.dev/api/archives/${JSR_PACKAGE}-${JSR_VERSION}.tar.gz`], { stdio: 'inherit' });
  }
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['xzf', tgz, '-C', dir]);
  execFileSync(flutter(), ['pub', 'get'], { cwd: dir, stdio: 'inherit' });
  buildQuickjsIfNeeded(dir);
  return dir;
}

// The QuickJS FFI backend needs libquickjs_bridge.so; build it once into the
// pub cache when the CLI's auto-discovery would come up empty.
function buildQuickjsIfNeeded(runtimeDir) {
  if (process.env.JSR_QUICKJS_LIB) return;
  const pubCache = process.env.PUB_CACHE || path.join(os.homedir(), '.pub-cache');
  const hosted = path.join(pubCache, 'hosted', 'pub.dev');
  if (!fs.existsSync(hosted)) return;
  const pkg = fs.readdirSync(hosted).find((d) => d.startsWith('quickjs_runtime-'));
  if (!pkg) return;
  const lib = path.join(hosted, pkg, 'native', 'quickjs', 'libquickjs_bridge.so');
  if (fs.existsSync(lib)) return;
  execFileSync('bash', ['tool/build_quickjs.sh'], {
    cwd: path.join(hosted, pkg),
    env: Object.assign({}, process.env, { CC: 'clang' }),
    stdio: 'inherit',
  });
}

function run(mode, state) {
  const cliMode = mode === 'verify' ? 'test' : 'screenshot';
  const args = [dart(), 'run', 'bin/jsr_widget.dart', cliMode, BUILD_DIR,
    '--width', WIDTH, '--height', HEIGHT, '--freeze-clock'];
  if (state.storage) args.push(...storageOpt(state.storage));
  for (const e of state.events || []) args.push('--event', e);
  if (mode === 'verify') {
    // The CLI's test-mode exit code is poisoned for rAF-at-boot widgets (the
    // boot rAF tick throws across the FFI boundary before any Dart binding
    // exists — upstream harness bug). The machine report is still written and
    // its `ok` flag reflects the expectations, so judge on that.
    const reportPath = path.join(path.dirname(BUILD_DIR), `${state.name}.report.json`);
    args.push('--expect-state', JSON.stringify(state.expect), '--json', '--out', reportPath);
    spawnSync(dart(), args.slice(1), {
      cwd: RUNTIME_DIR, env: process.env, stdio: ['ignore', 'ignore', 'inherit'],
    });
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.ok !== true) {
      throw new Error(`state mismatch: ${JSON.stringify(report.failures)}`);
    }
    return;
  }
  args.push('--out', path.join(OUT_DIR, `${state.name}.png`));
  execFileSync(dart(), args.slice(1), {
    cwd: RUNTIME_DIR,
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'], // progress chatter is noise; failures print to stderr
  });
}

function main() {
  const verb = process.argv[2] === 'verify' ? 'verify' : 'capture';
  buildWidgetDir();
  RUNTIME_DIR = jsrRuntimeDir();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = 0;
  for (const state of STATES) {
    try {
      run(verb, state);
      if (verb === 'capture') {
        const png = fs.readFileSync(path.join(OUT_DIR, `${state.name}.png`));
        const sha = crypto.createHash('sha256').update(png).digest('hex');
        console.log(`${state.name}.png  ${sha}`);
      } else {
        console.log(`${state.name}: state ok`);
      }
    } catch (e) {
      failed++;
      console.error(`${state.name}: FAILED — ${e.status !== undefined ? `exit ${e.status}` : e.message}`);
    }
  }
  if (failed) {
    console.error(`${failed}/${STATES.length} state(s) failed`);
    process.exit(1);
  }
  console.log(`${STATES.length}/${STATES.length} states ${verb === 'capture' ? 'captured' : 'verified'}`);
}

let RUNTIME_DIR;
main();
