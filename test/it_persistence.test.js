'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bootGame } = require('./harness.js');

const KEY = 'fa-craft:world:v1';

async function flushSave(jsr) {
  jsr.intervals.forEach((fn) => fn());
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('persistence: edits + autosave round-trip through jsr.storage (core)', async () => {
  const first = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = first.sandbox.Facraft;
  const seed = F.state.world.seed;
  F.world.setBlock(F.state.world, 5, 60, 5, F.blocks.BRICKS);
  F.world.setBlock(F.state.world, 6, 60, 5, F.blocks.BRICKS);
  await flushSave(first.jsr);
  assert.ok(first.jsr.storage.backing.has(KEY), 'world saved');
  const payload = JSON.parse(first.jsr.storage.backing.get(KEY));
  assert.strictEqual(payload.v, 1);
  assert.strictEqual(payload.seed, seed);
  assert.strictEqual(payload.log.length, 2, 'append-only log persisted');
  assert.strictEqual(payload.player && typeof payload.player.x, 'number', 'player pose persisted');

  const second = await bootGame({
    hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true },
    storage: { get: first.jsr.storage.get, set: first.jsr.storage.set }, // same "device"
  });
  const G = second.sandbox.Facraft;
  assert.strictEqual(G.state.world.seed, seed, 'same world resumes');
  assert.strictEqual(G.state.world.get(5, 60, 5), F.blocks.BRICKS, 'edits survived restart');
  assert.strictEqual(G.state.world.get(6, 60, 5), F.blocks.BRICKS, 'edits survived restart');
  assert.strictEqual(second.jsr.exported().edits, 2, 'edit count exported');
});

test('persistence: death + respawn persists consistently (E7)', async () => {
  const g = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = g.sandbox.Facraft;
  const w = F.state.world;
  // collect 9 blocks THROUGH the event log from GENERATED terrain, so
  // seed+ops reproduce the inventory exactly on reload (breaking blocks that
  // only exist in the live session would not replay)
  for (let i = 0; i < 9; i++) {
    const x = 3 + i;
    const gy = F.worldgen.groundY(w.seed, x, 3);
    F.world.apply(w, { t: 'set', x: x, y: gy, z: 3, b: 0 }); // break surface block → +1
  }
  F.survival.damage(w, 'void', 30);
  g.jsr.fire('respawn');
  await flushSave(g.jsr);
  const payload = JSON.parse(g.jsr.storage.backing.get(KEY));
  assert.ok(payload.log.some((op) => op.t === 'respawn'), 'respawn recorded in log');
  const g2 = await bootGame({ storage: { get: () => Promise.resolve(JSON.stringify(payload)) } });
  const inv = g2.jsr.exported().inventory;
  const total = Object.keys(inv).reduce((s, k) => s + inv[k], 0);
  assert.strictEqual(total, 9, '9 blocks gathered through the log');
  assert.deepStrictEqual({ ...inv }, { ...w.inventory }, 'inventory-by-log identical after reload');
  assert.strictEqual(g2.jsr.exported().health, 20);
  assert.strictEqual(g2.jsr.exported().dead, false);
});

test('persistence: corrupted save quarantines to a fresh world (E5)', async () => {
  const jsr = (await bootGame({ storage: { get: () => Promise.resolve('this is not json {') } })).jsr;
  const s = jsr.exported();
  assert.ok(s.notice && /fresh world/i.test(s.notice), 'visible quarantine notice');
  assert.strictEqual(s.dead, false, 'game still playable');
});

test('persistence: hostile log ops quarantined, never executed (E5)', async () => {
  const hostile = JSON.stringify({
    v: 1, seed: 3, dayTime: 0, log: [{ t: 'set', x: 0, y: 0, z: 0, b: 'DROP TABLE' }],
    player: null,
  });
  const jsr = (await bootGame({ storage: { get: () => Promise.resolve(hostile) } })).jsr;
  assert.ok(jsr.exported().notice && /fresh world/i.test(jsr.exported().notice), 'quarantine notice');
});

test('persistence: storage failure degrades with a notice, never crashes (E2)', async () => {
  const { jsr, sandbox } = await bootGame({
    hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true },
    storage: { set: () => Promise.reject(new Error('quota exceeded')) },
  });
  const F = sandbox.Facraft;
  F.world.setBlock(F.state.world, 1, 60, 1, F.blocks.LOG);
  await flushSave(jsr);
  assert.ok(jsr.exported().notice && /save/i.test(jsr.exported().notice), 'save-failure notice shown');
  assert.strictEqual(F.state.world.get(1, 60, 1), F.blocks.LOG, 'game continues playing');
});

test('persistence: kill mid-edit — replay stays consistent (E1)', async () => {
  const g = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = g.sandbox.Facraft;
  // rapid edits, then a "kill" right after an arbitrary op: flush whatever exists
  F.world.setBlock(F.state.world, 2, 60, 2, F.blocks.STONE);
  await flushSave(g.jsr);
  F.world.setBlock(F.state.world, 2, 45, 2, F.blocks.PLANKS); // post-save edit, "lost" by the kill
  const payload = JSON.parse(g.jsr.storage.backing.get(KEY));
  const g2 = await bootGame({ storage: { get: () => Promise.resolve(JSON.stringify(payload)) } });
  const G = g2.sandbox.Facraft;
  assert.strictEqual(G.state.world.get(2, 60, 2), F.blocks.STONE, 'pre-kill edits consistent');
  assert.strictEqual(G.state.world.get(2, 45, 2), F.blocks.AIR, 'no half-placed block from after the kill');
});
