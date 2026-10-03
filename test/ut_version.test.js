// The in-game status log prints Facraft.version; it must match the
// manifest version so field reports name the exact deployed build.
const assert = require('node:assert');
const { test } = require('node:test');
const { gameSourceText, manifest } = require('./harness.js');

test('version: game/main.js VERSION matches manifest.json', () => {
  const src = gameSourceText();
  const m = src.match(/var VERSION = '([^']+)'/);
  assert.ok(m, 'VERSION const present in main.js');
  assert.strictEqual(m[1], manifest().version,
    'main.js VERSION must equal manifest.json version');
});
