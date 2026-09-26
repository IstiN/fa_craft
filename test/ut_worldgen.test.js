'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/rng.js', 'game/noise.js', 'game/worldgen.js', 'game/blocks.js', 'game/world.js'];

test('worldgen: same seed yields byte-identical chunks (determinism)', async () => {
  const { F } = await loadNamespace(MODS);
  const a = F.worldgen.chunk(12345, 2, -3);
  const b = F.worldgen.chunk(12345, 2, -3);
  assert.strictEqual(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i], 'byte ' + i);
});

test('worldgen: different seeds differ', async () => {
  const { F } = await loadNamespace(MODS);
  const a = F.worldgen.chunk(1, 0, 0);
  const b = F.worldgen.chunk(2, 0, 0);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.ok(diff > 0, 'chunks from different seeds must differ');
});

test('worldgen: every column has bedrock floor and a natural surface material on top', async () => {
  const { F } = await loadNamespace(MODS);
  const surfaceOK = new Set([F.blocks.GRASS, F.blocks.SAND, F.blocks.STONE]);
  const c = F.worldgen.chunk(42, 0, 0);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      assert.strictEqual(c[F.worldgen.index(x, 0, z)], F.blocks.BEDROCK, 'bedrock at ' + x + ',' + z);
      let top = F.blocks.AIR;
      for (let y = F.worldgen.CHUNK_Y - 1; y >= 0; y--) {
        const b = c[F.worldgen.index(x, y, z)];
        if (b !== F.blocks.AIR) { top = b; break; }
      }
      assert.ok(surfaceOK.has(top), 'column ' + x + ',' + z + ' tops with ' + top);
    }
  }
});

test('worldgen: bedrock floor at y=0, never breakable material', async () => {
  const { F } = await loadNamespace(MODS);
  const c = F.worldgen.chunk(7, 0, 1);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      assert.strictEqual(c[F.worldgen.index(x, 0, z)], F.blocks.BEDROCK);
    }
  }
});

test('worldgen: biome-lite surface materials exist (grass and sand patches)', async () => {
  const { F } = await loadNamespace(MODS);
  const found = new Set();
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      const c = F.worldgen.chunk(99, cx, cz);
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          for (let y = F.worldgen.CHUNK_Y - 1; y > 0; y--) {
            const b = c[F.worldgen.index(x, y, z)];
            if (b !== F.blocks.AIR) { found.add(b); break; }
          }
        }
      }
    }
  }
  assert.ok(found.has(F.blocks.GRASS), 'grass surface expected');
  assert.ok(found.has(F.blocks.SAND), 'sand patches expected');
  assert.ok(found.has(F.blocks.STONE) || found.has(F.blocks.DIRT), 'subsurface material expected');
});

test('worldgen: caves carve air below the surface', async () => {
  const { F } = await loadNamespace(MODS);
  let caveAir = 0;
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const c = F.worldgen.chunk(42, cx, cz);
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          // count air strictly below y=20 (deep enough to be caves, not surface)
          for (let y = 2; y < 20; y++) if (c[F.worldgen.index(x, y, z)] === F.blocks.AIR) caveAir++;
        }
      }
    }
  }
  assert.ok(caveAir > 50, 'expected cave voids below y=20, got ' + caveAir);
});
