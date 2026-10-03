'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/rng.js', 'game/noise.js', 'game/blocks.js', 'game/worldgen.js', 'game/world.js', 'game/voxel.js', 'game/fx.js'];

function stubWorld(F) {
  const w = { seed: 1, chunks: {}, dirty: new Set(), meshes: new Map(),
    player: { x: 100.5, y: 50, z: 100.5 } };
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      w.chunks[F.world.key(cx, cz)] = new Uint8Array(16 * 64 * 16);
    }
  }
  return w;
}

test('fx: burst particles fly, die on solids, and expire', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.fx.burst(w, 0.5, 42.5, 0.5, [[1, 0, 0]], 10);
  assert.strictEqual(F.fx.particleCount(), 10, 'burst spawns particles');
  F.fx.tick(w, 0.05);
  assert.strictEqual(F.fx.particleCount(), 10, 'all fly on (all-air world, nothing to hit)');
  for (let i = 0; i < 40; i++) F.fx.tick(w, 0.05); // 2s >> max life 0.75s
  assert.strictEqual(F.fx.particleCount(), 0, 'all particles expire');
});

test('fx: burst inside a solid block pops immediately', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.world.setBlock(w, 0, 40, 0, F.blocks.STONE);
  F.fx.burst(w, 0.5, 40.5, 0.5, [[1, 1, 1]], 8);
  F.fx.tick(w, 0.016);
  assert.strictEqual(F.fx.particleCount(), 0, 'no particle survives inside stone');
});

test('fx: meat drop pops up, lands on the ground, rests', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) F.world.setBlock(w, x, 39, z, F.blocks.STONE);
  }
  F.fx.spawnDrop(w, 2.5, 44, 2.5, 'chicken');
  assert.strictEqual(w.drops.length, 1);
  let d = w.drops[0];
  for (let i = 0; i < 200 && d.vy !== 0; i++) F.fx.tick(w, 0.016);
  assert.strictEqual(d.vy, 0, 'drop comes to rest');
  assert.ok(Math.abs(d.y - 40.06) < 0.05, 'rests on the ground top: ' + d.y);
});

test('fx: walking over a drop collects it; far player does not', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.fx.spawnDrop(w, 5.5, 42, 5.5, 'pig');
  // (loose length checks: the arrays are vm-context objects, deepStrictEqual
  // would fail on prototype mismatch)
  const far = F.fx.tick(w, 0.016);
  assert.strictEqual(far.length, 0, 'player 100 blocks away collects nothing');
  w.player.x = 5.5; w.player.y = 41.2; w.player.z = 5.5;
  const got = F.fx.tick(w, 0.016);
  assert.strictEqual(got.length, 1, 'one pickup');
  assert.strictEqual(got[0], 'pig', 'walk-over collects the pork chop');
  assert.strictEqual(w.drops.length, 0, 'drop consumed');
});

test('fx: an uncollected drop despawns after 45s without a collect', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.fx.spawnDrop(w, 5.5, 42, 5.5, 'chicken');
  for (let i = 0; i < 300; i++) F.fx.tick(w, 0.2); // 60s
  assert.strictEqual(w.drops.length, 0, 'despawned');
});
