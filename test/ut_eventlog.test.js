'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/rng.js', 'game/noise.js', 'game/blocks.js', 'game/worldgen.js', 'game/craft.js', 'game/survival.js', 'game/world.js', 'game/eventlog.js'];

function sample(world) {
  const out = [];
  for (let x = -20; x <= 20; x += 3) {
    for (let z = -20; z <= 20; z += 3) {
      for (let y = 0; y <= 50; y += 7) out.push(world.get(x, y, z));
    }
  }
  return out.join(',');
}

test('event log: replay(seed, ops) reconstructs edits deterministically (I3)', async () => {
  const { F } = await loadNamespace(MODS);
  const ops = [
    { t: 'set', x: 3, y: 40, z: 4, b: F.blocks.PLANKS },
    { t: 'set', x: 3, y: 41, z: 4, b: F.blocks.PLANKS },
    { t: 'set', x: -9, y: 12, z: 30, b: 0 },
  ];
  const w1 = F.world.fromLog(7, ops);
  const w2 = F.world.fromLog(7, ops);
  assert.strictEqual(sample(w1), sample(w2));
  assert.strictEqual(w1.get(3, 40, 4), F.blocks.PLANKS);
  assert.strictEqual(w1.get(3, 41, 4), F.blocks.PLANKS);
});

test('event log: append-only — ops stay in order, length equals appends (E4)', async () => {
  const { F } = await loadNamespace(MODS);
  const log = F.eventlog.create();
  for (let i = 0; i < 500; i++) {
    log.append({ t: 'set', x: i % 16, y: 30, z: i % 16, b: i % 2 });
  }
  assert.strictEqual(log.ops.length, 500);
  for (let i = 1; i < 500; i++) {
    assert.ok(log.ops[i].seq > log.ops[i - 1].seq, 'seq strictly increases');
  }
});

test('event log: rapid edits replay to a consistent world (E4)', async () => {
  const { F } = await loadNamespace(MODS);
  const log = F.eventlog.create();
  for (let i = 0; i < 200; i++) {
    log.append({ t: 'set', x: 1, y: 30 + (i % 3), z: 1, b: i % 3 });
  }
  const w = F.world.fromLog(11, log.ops);
  // last write wins on the hot voxel
  const last = log.ops[log.ops.length - 1];
  assert.strictEqual(w.get(1, 30 + (199 % 3), 1), last.b);
});

test('event log: replaying the same log twice is idempotent (E1 mid-edit resume)', async () => {
  const { F } = await loadNamespace(MODS);
  const ops = [{ t: 'set', x: 0, y: 35, z: 0, b: F.blocks.STONE }];
  const once = F.world.fromLog(5, ops);
  const twice = F.world.fromLog(5, ops);
  F.world.apply(once, ops[0]);
  assert.strictEqual(sample(once), sample(twice));
});

test('event log: hostile ops are rejected by validation (E5)', async () => {
  const { F } = await loadNamespace(MODS);
  assert.throws(() => F.world.fromLog(5, [{ t: 'eval', code: 'evil()' }]));
  assert.throws(() => F.world.fromLog(5, [{ t: 'set', x: 1e9, y: 0, z: 0, b: 1 }]));
  assert.throws(() => F.world.fromLog(5, [{ t: 'set', x: 0, y: 9999, z: 0, b: 1 }]));
  assert.throws(() => F.world.fromLog(5, [{ t: 'set', x: 0.5, y: 0, z: 0, b: 1 }]));
  assert.throws(() => F.world.fromLog(5, [{ t: 'set', x: 0, y: 0, z: 0, b: 255 }]));
  assert.throws(() => F.world.fromLog(5, 'not an array'));
});

test('event log: world.set rejects bedrock break and out-of-range', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(3);
  assert.throws(() => F.world.setBlock(w, 0, 0, 0, F.blocks.AIR), /bedrock/i);
  assert.throws(() => F.world.setBlock(w, 0, 999, 0, F.blocks.STONE));
  F.world.setBlock(w, 0, 40, 0, F.blocks.LOG);
  assert.strictEqual(w.get(0, 40, 0), F.blocks.LOG);
});

test('event log: crafting/damage/respawn/mode ops validate (E5, rules in log)', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(3);
  w.inventory[F.blocks.LOG] = 2; // materials for the craft op
  F.world.apply(w, { t: 'mode', m: 'creative' });
  F.world.apply(w, { t: 'craft', r: 'planks', n: 1 });
  F.world.apply(w, { t: 'damage', cause: 'fall', n: 3 });
  F.world.apply(w, { t: 'respawn' });
  assert.throws(() => F.world.apply(w, { t: 'craft', r: 'nonexistent' }));
  assert.throws(() => F.world.apply(w, { t: 'damage', cause: 'fall', n: -5 }));
  assert.throws(() => F.world.apply(w, { t: 'mode', m: 'grief' }));
});
