'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/blocks.js', 'game/craft.js'];

test('craft: fixed recipe table exists with planks, sticks, bricks', async () => {
  const { F } = await loadNamespace(MODS);
  const ids = F.craft.recipes.map((r) => r.id);
  assert.ok(ids.includes('planks'), 'planks');
  assert.ok(ids.includes('sticks'), 'sticks');
  assert.ok(ids.includes('bricks'), 'bricks');
  assert.strictEqual(F.craft.recipes.length, ids.length, 'unique ids');
});

test('craft: logs craft into planks (broken blocks → materials)', async () => {
  const { F } = await loadNamespace(MODS);
  const inv = {};
  inv[F.blocks.LOG] = 2;
  const r = F.craft.craft(inv, 'planks', 1);
  assert.ok(r.ok, 'craft succeeds');
  assert.strictEqual(r.inv[F.blocks.PLANKS], 4, 'planks produced');
  assert.strictEqual(r.inv[F.blocks.LOG], 1, 'log consumed');
  // original untouched (purity)
  assert.strictEqual(inv[F.blocks.LOG], 2);
  assert.strictEqual(inv[F.blocks.PLANKS], undefined);
});

test('craft: insufficient materials fail closed with a reason', async () => {
  const { F } = await loadNamespace(MODS);
  const inv = {};
  inv[F.blocks.LOG] = 0;
  const r = F.craft.craft(inv, 'planks', 1);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test('craft: chain planks → sticks works from broken blocks', async () => {
  const { F } = await loadNamespace(MODS);
  let inv = {};
  inv[F.blocks.LOG] = 3;
  inv = F.craft.craft(inv, 'planks', 3).inv; // 12 planks
  const r = F.craft.craft(inv, 'sticks', 2); // 2×(2 planks → 4 sticks)
  assert.ok(r.ok);
  assert.strictEqual(r.inv.stick, 8);
  assert.strictEqual(r.inv[F.blocks.PLANKS], 12 - 4);
});

test('craft: unknown recipe and bad counts fail', async () => {
  const { F } = await loadNamespace(MODS);
  assert.strictEqual(F.craft.craft({}, 'sword-of-doom', 1).ok, false);
  assert.strictEqual(F.craft.craft({}, 'planks', 0).ok, false);
  assert.strictEqual(F.craft.craft({}, 'planks', -1).ok, false);
});

test('craft: fractional inventory never crafts (E5 hostile data shape)', async () => {
  const { F } = await loadNamespace(MODS);
  const inv = {};
  inv[F.blocks.LOG] = 1.5;
  assert.strictEqual(F.craft.craft(inv, 'planks', 1).ok, false, 'fractional counts are hostile');
});
