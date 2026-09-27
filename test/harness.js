'use strict';
// Test harness: loads the real widget sources (game/*.js) the same way
// flutter_js_widget_runtime does — relative `import './x.js'` lines inlined
// once in source order, `export` keywords stripped, one shared scope — then
// boots them in a vm context with a controllable fake `jsr` host.
// When .nyc-src/ exists (nyc instrument output), sources are loaded from
// there instead so eval'd code still feeds coverage-final.json.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const COV_DIR = path.join(ROOT, '.nyc-src');

function loadSource(rel) {
  const candidates = [
    path.join(COV_DIR, rel.replace(/^game\//, '')),
    path.join(COV_DIR, rel),
    path.join(ROOT, rel),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { abs: path.resolve(c), code: fs.readFileSync(c, 'utf8') };
  }
  throw new Error('source not found: ' + rel);
}

// Matches `import './x.js';` on its own line (widget sources) AND compacted
// runs like `import'./x.js';import'./y.js';` (nyc's ESM instrumenter output).
const IMPORT_RE = /import\s*['"](\.[^'"]+)['"]\s*;?/g;

// Mirrors the runtime inliner: resolve relative imports depth-first in source
// order, inline each file once, strip `export` keywords, depth cap 5.
function bundle(rel, depth, seen, out) {
  if (depth > 5) throw new Error('import depth cap exceeded at ' + rel);
  if (seen.has(rel)) return;
  seen.add(rel);
  const { abs, code } = loadSource(rel);
  let m;
  IMPORT_RE.lastIndex = 0;
  const imports = [];
  while ((m = IMPORT_RE.exec(code)) !== null) {
    imports.push(path.join(path.dirname(rel), m[1]));
  }
  for (const dep of imports) bundle(dep, depth + 1, seen, out);
  const own = code.replace(IMPORT_RE, '').replace(/^\s*export\s+/gm, '');
  out.push({ file: rel, abs, code: own });
}

function fakeStorage() {
  const backing = new Map();
  return {
    backing,
    failSets: false,
    get(key) {
      return Promise.resolve(backing.has(key) ? backing.get(key) : null);
    },
    set(key, value) {
      if (this.failSets) return Promise.reject(new Error('storage quota exceeded'));
      backing.set(key, value);
      return Promise.resolve(true);
    },
  };
}

// Fake jsr host: records every outbound bridge call, queues rAF callbacks for
// manual pumping, and lets tests fire events/keys.
function fakeJsr() {
  const calls = [];
  const rafQ = [];
  const intervals = [];
  const eventHandlers = [];
  const keyHandlers = [];
  const storage = fakeStorage();
  let exportState = {};
  const jsr = {
    calls,
    storage,
    instanceId: 'test-inst',
    theme: {
      isDark: true, bg: '#0f172a', surface: '#1e293b', surfaceAlt: '#293548',
      border: '#334155', borderBright: '#475569', accent: '#818cf8',
      accent2: '#a78bfa', onAccent: '#0f172a', text: '#f1f5f9', muted: '#64748b',
    },
    render(tree) { calls.push(['render', 0]); jsr.lastTree = tree; },
    setTitle(t) { calls.push(['setTitle', 0]); jsr.title = t; },
    exportState(obj) { calls.push(['exportState', 0]); exportState = obj; },
    showError(msg) { calls.push(['showError', 0]); jsr.error = msg; },
    onEvent(fn) { eventHandlers.push(fn); },
    onKey(fn) { keyHandlers.push(fn); },
    onViewport(fn) { jsr._viewportFn = fn; },
    viewport() { return { width: 480, height: 720 }; },
    hostCall(name, args) {
      calls.push(['hostCall:' + name, approximateJsonSize(args)]);
      if (name === 'voxel.attach') return Promise.resolve({ ok: true }); // host capability probe
      if (!jsr.hostHandlers[name]) return Promise.reject(new Error('no handler for ' + name));
      return Promise.resolve(jsr.hostHandlers[name](args));
    },
    hostHandlers: {},
    requestAnimationFrame(fn) { rafQ.push(fn); return rafQ.length; },
    setTimeout(fn, ms) { return 0; },
    clearTimeout() {},
    setInterval(fn, ms) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    // --- test controls ---
    intervals,
    exported: () => exportState,
    fire(actionId, payload) {
      calls.push(['event:' + actionId, 0]);
      eventHandlers.forEach((fn) => fn(actionId, payload));
    },
    fireKey(ev) { keyHandlers.forEach((fn) => fn(ev)); },
    async pumpFrames(frames, dtMs) {
      const results = [];
      for (let f = 0; f < frames; f++) {
        const q = rafQ.splice(0, rafQ.length);
        const t = (f + 1) * dtMs;
        q.forEach((fn) => fn(t));
        await new Promise((r) => setImmediate(r)); // let promise callbacks settle like a real frame gap
        results.push(calls.filter((c) => c[0] === 'render').length);
      }
      return results;
    },
    callCount(prefix) {
      return calls.filter((c) => prefix === '' || c[0].startsWith(prefix)).length;
    },
  };
  return jsr;
}

function approximateJsonSize(v) {
  try { return JSON.stringify(v).length; } catch (e) { return -1; }
}

// Boot the widget fresh. Returns { jsr, done } — `done()` awaits the boot's
// async storage hydration (Promise microtasks settle before it resolves).
async function bootGame(opts) {
  const jsr = fakeJsr();
  if (opts && opts.hostHandlers) Object.assign(jsr.hostHandlers, opts.hostHandlers);
  if (opts && opts.storage) Object.assign(jsr.storage, opts.storage);
  const seen = new Set();
  const out = [];
  bundle('game/main.js', 1, seen, out);
  const sandbox = {
    jsr,
    console,
    Promise,
    Math,
    Date,
    JSON,
    Object,
    Array,
    isNaN,
    parseInt,
    parseFloat,
    Uint8Array,
    // host-shimmed timers (globals in the widget sandbox, per the runtime)
    requestAnimationFrame: (fn) => jsr.requestAnimationFrame(fn),
    setTimeout: (fn, ms) => jsr.setTimeout(fn, ms),
    clearTimeout: (id) => jsr.clearTimeout(id),
    setInterval: (fn, ms) => jsr.setInterval(fn, ms),
    clearInterval: (id) => jsr.clearInterval(id),
    __coverage__: global.__coverage__ || (global.__coverage__ = {}),
  };
  const ctx = vm.createContext(sandbox);
  for (const f of out) {
    new vm.Script(f.code, { filename: f.abs }).runInContext(ctx);
  }
  await new Promise((r) => setImmediate(r));
  return { jsr, sandbox };
}

// Load a specific module set (no widget bootstrap) for pure-logic tests.
async function loadNamespace(rels, opts) {
  const jsr = fakeJsr();
  if (opts && opts.hostHandlers) Object.assign(jsr.hostHandlers, opts.hostHandlers);
  const sandbox = {
    jsr,
    console,
    Promise,
    Math,
    Date,
    JSON,
    Object,
    Array,
    isNaN,
    parseInt,
    parseFloat,
    Uint8Array,
    __coverage__: global.__coverage__ || (global.__coverage__ = {}),
  };
  const ctx = vm.createContext(sandbox);
  const seen = new Set();
  const out = [];
  for (const rel of rels) bundle(rel, 1, seen, out);
  for (const f of out) {
    new vm.Script(f.code, { filename: f.abs }).runInContext(ctx);
  }
  return { jsr, sandbox, F: sandbox.Facraft };
}

function gameSourceText() {
  const seen = new Set();
  const out = [];
  bundle('game/main.js', 1, seen, out);
  return out.map((f) => f.code).join('\n');
}

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
}

module.exports = { bootGame, loadNamespace, gameSourceText, manifest, fakeJsr, fakeStorage };

// Per-test-process coverage dump (merged later into coverage/coverage-final.json).
process.on('exit', () => {
  if (!global.__coverage__) return;
  const dir = path.join(ROOT, '.nyc_output');
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(process.argv[1] || 'proc') + '-' + process.pid + '.json';
  fs.writeFileSync(path.join(dir, name), JSON.stringify(global.__coverage__));
});
