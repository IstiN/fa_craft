'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/rng.js', 'game/noise.js', 'game/blocks.js',
  'game/worldgen.js', 'game/world.js', 'game/mesh.js', 'game/voxel.js'];

test('perf: budgetFor clamps the stream budget by tick cost', async () => {
  const { F } = await loadNamespace(MODS);
  const V = F.voxel;
  assert.strictEqual(V.budgetFor(8), 3, 'fast frame keeps the full budget');
  assert.strictEqual(V.budgetFor(16.7), 3, 'healthy 60 fps keeps 3');
  assert.strictEqual(V.budgetFor(23), 2, 'overrun drops to 2');
  assert.strictEqual(V.budgetFor(34), 1, 'hard hitch drops to 1');
  assert.strictEqual(V.budgetFor(0), 3, 'frozen clocks (goldens) keep 3');
  assert.strictEqual(V.budgetFor(NaN), 3, 'garbage keeps 3');
  // setBudget clamps; sync reads the clamped value.
  V.setBudget(99);
  assert.strictEqual(V.currentBudget(), 3, 'clamped high');
  V.setBudget(-5);
  assert.strictEqual(V.currentBudget(), 1, 'clamped low');
  V.setBudget(2.6);
  assert.strictEqual(V.currentBudget(), 3, 'rounded');
  V.setBudget('x');
  assert.strictEqual(V.currentBudget(), 3, 'garbage ignored');
});

test('perf: b64 matches Node base64 on exact and ragged lengths', async () => {
  const { F } = await loadNamespace(MODS);
  const V = F.voxel;
  const cases = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([0, 255]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([255, 254, 253, 252]),
    new Uint8Array(16 * 64 * 16), // a whole chunk of air
  ];
  const chunk = new Uint8Array(16 * 64 * 16);
  for (let i = 0; i < chunk.length; i += 7) chunk[i] = (i * 13 + 5) & 0xFF;
  cases.push(chunk);
  for (const c of cases) {
    assert.strictEqual(V.b64(c), Buffer.from(c).toString('base64'),
      `length ${c.length}`);
  }
});

test('perf: paletteSpec matches the voxel.blocks contract', async () => {
  const { F } = await loadNamespace(MODS);
  const B = F.blocks;
  const spec = B.paletteSpec();
  assert.strictEqual(spec.length, B.MAX + 1, 'one entry per block type');
  assert.ok(spec[0].every((h) => h === '#000000'), 'entry 0 is the air placeholder');
  // Grass carries top/side palettes (dirt-green sides, green top).
  const grass = spec[B.GRASS];
  assert.ok(grass.top && grass.side && grass.top.length === 4 &&
    grass.side.length === 4, 'grass: {top, side} x4');
  assert.notDeepStrictEqual(grass.top, grass.side, 'grass sides differ from top');
  // Every other type: a flat 4-tone palette, all valid #rrggbb.
  const hexRe = /^#[0-9a-f]{6}$/;
  for (let i = 1; i <= B.MAX; i++) {
    const e = spec[i];
    const tones = Array.isArray(e) ? e : e.top;
    assert.strictEqual(tones.length, 4, `type ${i} has 4 tones`);
    for (const t of tones) assert.ok(hexRe.test(t), `type ${i} tone ${t}`);
  }
});

test('perf: worldgen chunk bytes feed voxel.blocks directly', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(7);
  F.world.pregen(w, 0, 0); // data-only warm-up fills w.chunks['0,0']
  const c = w.chunks['0,0'];
  assert.ok(c instanceof Uint8Array, 'chunks are byte arrays');
  assert.strictEqual(c.length, 16 * 64 * 16);
  // The chunk is non-empty terrain (surface + stone below).
  let solids = 0;
  for (let i = 0; i < c.length; i++) if (F.blocks.isSolid(c[i])) solids++;
  assert.ok(solids > 1000, 'seed 7 spawn chunk has terrain');
});
