'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/rng.js', 'game/noise.js', 'game/worldgen.js', 'game/blocks.js', 'game/world.js'];

test('noise: hot-loop optimization stays bit-identical to the 0.2.30 reference', async () => {
  const { F } = await loadNamespace(['game/noise.js']);
  const cases = [
    [0, [-0.6508482650370001, 0.19352836773145676, -0.3818914225847948, 0.2623341590703416]],
    [1, [0.3338790521712436, -0.15641590217540002, 0.2817592066111182, 0.07939613491538464]],
    [42, [-0.2924024607048561, 0.04610616837257964, -0.22220994412543688, 0.031333146383601296]],
    [123, [-0.1378046241056612, -0.3872984471009552, -0.27498118584015074, -0.35145835972833617]],
    [499, [-0.06747158654427998, 0.19858755513785842, 0.018173708699353256, 0.2616729880331189]],
  ];
  for (const [i, expected] of cases) {
    const seed = (i * 7919) | 0;
    const x = (i % 37 - 18) * 0.137, y = (i % 23) * 0.191, z = (i % 41 - 20) * 0.113;
    assert.deepStrictEqual([
      F.noise.value2(seed, x, z), F.noise.value3(seed, x, y, z),
      F.noise.fbm2(seed, x, z, 4), F.noise.fbm3(seed, x, y, z, 3),
    ], expected, 'reference row ' + i);
  }
});

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

test('worldgen: analytical groundY matches a generated-chunk column scan', async () => {
  const { F } = await loadNamespace(MODS);
  for (const seed of [1, 42, 777, 1210892288]) {
    const chunks = new Map(); // one generation per chunk, scanned per column
    for (let wx = -40; wx <= 40; wx += 7) {
      for (let wz = -40; wz <= 40; wz += 7) {
        const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
        const ck = cx + ',' + cz;
        if (!chunks.has(ck)) chunks.set(ck, F.worldgen.chunk(seed, cx, cz));
        const c = chunks.get(ck);
        const lx = wx - cx * 16, lz = wz - cz * 16;
        let scan = 0;
        for (let y = F.worldgen.CHUNK_Y - 1; y >= 0; y--) {
          if (c[F.worldgen.index(lx, y, lz)] !== 0) { scan = y; break; }
        }
        assert.strictEqual(F.worldgen.groundY(seed, wx, wz), scan,
          'seed ' + seed + ' column ' + wx + ',' + wz);
      }
    }
  }
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
