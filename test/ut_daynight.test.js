'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/daynight.js'];

test('daynight: full period advances monotonically and wraps', async () => {
  const { F } = await loadNamespace(MODS);
  let t = 0;
  let prev = t;
  for (let i = 0; i < 1000; i++) {
    t = F.daynight.advance(t, 0.1);
    assert.ok(t > prev || (prev > F.daynight.PERIOD * 0.99 && t < prev), 'monotonic or wrapped');
    prev = t;
  }
  t = F.daynight.advance(F.daynight.PERIOD - 0.05, 0.1);
  assert.ok(t < 0.1, 'wraps around the period');
});

test('daynight: noon is bright, midnight is dark', async () => {
  const { F } = await loadNamespace(MODS);
  const noon = F.daynight.sky(0);
  const midnight = F.daynight.sky(F.daynight.PERIOD / 2);
  assert.ok(noon.light > 0.9, 'noon light ' + noon.light);
  assert.ok(midnight.light < 0.35, 'midnight light ' + midnight.light);
  assert.notStrictEqual(noon.color, midnight.color, 'sky color shifts');
});

test('daynight: sky() is deterministic and clamped outside the period', async () => {
  const { F } = await loadNamespace(MODS);
  const a = F.daynight.sky(123.4);
  const b = F.daynight.sky(123.4);
  assert.deepStrictEqual(a, b);
  const beyond = F.daynight.sky(F.daynight.PERIOD * 5 + 7);
  const same = F.daynight.sky(7);
  assert.deepStrictEqual(beyond, same, 'wraps modulo the period');
});
