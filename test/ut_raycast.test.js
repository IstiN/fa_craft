'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/rng.js', 'game/noise.js', 'game/blocks.js', 'game/worldgen.js', 'game/world.js', 'game/raycast.js'];

test('raycast: hits the first solid block along -z and returns entry face normal', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(1);
  F.world.setBlock(w, 0, 60, -4, F.blocks.STONE);
  const hit = F.raycast.pick(w, 0.5, 60.5, 0.5, 0, 0, -1, 6);
  assert.ok(hit.hit, 'must hit');
  assert.deepStrictEqual([hit.x, hit.y, hit.z], [0, 60, -4]);
  // walked -z, entered through the +z face of the block
  assert.deepStrictEqual([hit.nx, hit.ny, hit.nz], [0, 0, 1]);
});

test('raycast: previous cell is the placement cell', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(1);
  F.world.setBlock(w, 3, 60, 0, F.blocks.STONE);
  const hit = F.raycast.pick(w, 0.5, 60.5, 0.5, 1, 0, 0, 6);
  assert.ok(hit.hit);
  assert.deepStrictEqual([hit.px, hit.py, hit.pz], [2, 60, 0], 'placement cell before the hit block');
});

test('raycast: returns no hit beyond max distance', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(1);
  F.world.setBlock(w, 0, 60, -9, F.blocks.STONE);
  const hit = F.raycast.pick(w, 0.5, 60.5, 0.5, 0, 0, -1, 6);
  assert.strictEqual(hit.hit, false);
});

test('raycast: diagonal rays hit and never skip blocks', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(1);
  F.world.setBlock(w, 3, 60, -3, F.blocks.LOG);
  const len = Math.sqrt(3);
  const hit = F.raycast.pick(w, 0.5, 60.5, 0.5, 1 / len, 0, -1 / len, 8);
  assert.ok(hit.hit, 'diagonal must reach the block');
  assert.deepStrictEqual([hit.x, hit.y, hit.z], [3, 60, -3]);
});

test('raycast: air and non-solid return no hit', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(1);
  const hit = F.raycast.pick(w, 0.5, 70.5, 0.5, 0, -1, 0, 6);
  assert.strictEqual(hit.hit, false, 'open sky above, nothing within reach');
});

test('raycast: starts inside a block → hit that block with zero normal', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(1);
  F.world.setBlock(w, 0, 60, 0, F.blocks.STONE);
  const hit = F.raycast.pick(w, 0.5, 60.5, 0.5, 0, 0, -1, 6);
  assert.ok(hit.hit);
  assert.deepStrictEqual([hit.x, hit.y, hit.z], [0, 60, 0]);
});
