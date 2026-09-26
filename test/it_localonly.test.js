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
  assert.ok(tokens.length > 10, 'widget actually uses the bridge');
  const used = new Set(tokens.map((t) => t.slice(4)));
  for (const t of used) {
    assert.ok(allow.has(t), 'bridge call jsr.' + t + ' is not on the local-only allow-list');
  }
});

test('I2: hostCall names are generic voxel capabilities only (I1 — no game logic in host)', () => {
  const src = gameSourceText();
  const names = src.match(/hostCall\(\s*'([^']+)'/g) || [];
  assert.ok(names.length > 0, 'voxel adapter uses hostCall');
  for (const raw of names) {
    const name = raw.replace(/hostCall\(\s*'/, '').replace(/'$/, '');
    assert.ok(/^voxel\.(mesh|camera|attach|light)$/.test(name), 'host capability ' + name + ' outside the voxel contract');
  }
});
