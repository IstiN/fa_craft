'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { gameSourceText, manifest } = require('./harness.js');

test('I2: manifest opts out of networking', () => {
  const m = manifest();
  assert.strictEqual(m.network, false, 'network: false in manifest');
  assert.deepStrictEqual(m.allowedCommands, [], 'no shell commands allowed');
  assert.strictEqual(m.id, 'fa-craft');
});

test('I2: no fetch/WebSocket transport anywhere in the game source', () => {
  const src = gameSourceText();
  assert.ok(!/fetchJson/.test(src), 'no jsr.fetchJson calls');
  assert.ok(!/\.fetch\s*\(/.test(src), 'no fetch() calls');
  assert.ok(!/XMLHttpRequest|WebSocket|EventSource|sendBeacon/i.test(src), 'no browser transports');
  assert.ok(!/https?:\/\//.test(src), 'no network URLs in code');
});

test('I2: byte-scan of outbound bridge surface — only the allow-list', () => {
  const src = gameSourceText();
  const allow = new Set([
    'render', 'onEvent', 'setTitle', 'exportState', 'showError', 'onKey',
    'storage', 'theme', 'instanceId', 'viewport', 'onViewport', 'hostCall',
    'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  ]);
  const tokens = src.match(/jsr\.([A-Za-z_$][\w$]*)/g) || [];
  assert.ok(tokens.length > 5, 'widget actually uses the bridge'); // render/export/theme/storage/events/title
  const used = new Set(tokens.map((t) => t.slice(4)));
  for (const t of used) {
    assert.ok(allow.has(t), 'bridge call jsr.' + t + ' is not on the local-only allow-list');
  }
});

test('I2: game bridge traffic uses only generic voxel.* hostCalls (I1)', () => {
  const src = gameSourceText();
  // I4: the voxel node port moved chunk/camera transport to bridge-owned
  // voxel.* hostCalls. The I1 invariant stands — every hostCall name must
  // be a generic voxel capability, never a fa-craft-specific channel.
  const names = (src.match(/hostCall\(\s*'([^']+)'/g) || [])
    .map((m) => m.match(/'([^']+)'/)[1]);
  assert.ok(names.length > 0, 'the native voxel path actually uses hostCall');
  for (const n of names) {
    assert.ok(n.startsWith('voxel.'), 'only voxel.* hostCalls allowed, got: ' + n);
  }
});
