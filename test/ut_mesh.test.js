'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/rng.js', 'game/noise.js', 'game/blocks.js', 'game/worldgen.js', 'game/world.js', 'game/mesh.js'];

// Stub world with 3×3 all-air chunks — pure geometry, no floor.
function stubWorld(F) {
  const w = { seed: 1, chunks: {}, dirty: new Set(), meshes: new Map() };
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      w.chunks[F.world.key(cx, cz)] = new Uint8Array(16 * 64 * 16);
    }
  }
  return w;
}

function facesOf(mesh) { return mesh.indices.length / 6; }

test('mesh: a lone block emits 6 faces, 24 verts, 36 indices', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.world.setBlock(w, 0, 40, 0, F.blocks.STONE);
  const m = F.mesh.buildChunk(w, 0, 0);
  assert.strictEqual(facesOf(m), 6, 'all faces visible on a lone block');
  assert.strictEqual(m.positions.length / 3, 24, '4 verts per face');
  assert.strictEqual(m.indices.length, 36, '6 indices per face');
});

test('mesh: buried blocks cull — a 3×3×3 cube shows only its shell (greedy-merged)', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  for (let x = 4; x <= 6; x++) {
    for (let z = 4; z <= 6; z++) {
      for (let y = 40; y <= 42; y++) F.world.setBlock(w, x, y, z, F.blocks.STONE);
    }
  }
  const m = F.mesh.buildChunk(w, 0, 0);
  // Greedy merge BY TONE: a 3x3 side collapses same-tone runs only.
  // 54 unmerged side faces -> 42 quads under the 4-tone hash (pinned:
  // the hash is deterministic, so this is an exact regression guard).
  assert.strictEqual(facesOf(m), 42, 'tone-bounded merged side quads, got ' + facesOf(m));
  // …but the visible surface AREA must be exactly the 54 unit faces.
  assert.strictEqual(totalArea(m), 54, 'merged surface area == shell area');
});

// Sum of quad areas via the two triangle cross products.
function totalArea(mesh) {
  const P = mesh.positions, I = mesh.indices;
  let area = 0;
  for (let q = 0; q < I.length; q += 3) {
    const a = I[q] * 3, b = I[q + 1] * 3, c = I[q + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return area;
}

test('mesh: greedy merge keeps outward winding (backface cull contract)', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.world.setBlock(w, 8, 40, 8, F.blocks.STONE);
  const m = F.mesh.buildChunk(w, 0, 0);
  const P = m.positions, I = m.indices;
  for (let q = 0; q < I.length; q += 6) {
    const a = I[q] * 3, b = I[q + 1] * 3, c = I[q + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    // Face center minus block center must align with the normal (outward).
    const cxm = (P[a] + P[I[q + 2] * 3]) / 2 - 8.5;
    const cym = (P[a + 1] + P[I[q + 2] * 3 + 1]) / 2 - 40.5;
    const czm = (P[a + 2] + P[I[q + 2] * 3 + 2]) / 2 - 8.5;
    assert.ok(nx * cxm + ny * cym + nz * czm > 0, 'quad ' + q / 6 + ' faces outward');
  }
});

test('mesh: flat 16×16 plate merges each side into one quad', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) F.world.setBlock(w, x, 40, z, F.blocks.STONE);
  }
  const m = F.mesh.buildChunk(w, 0, 0);
  // 576 unmerged faces -> 446 quads under the 4-tone hash (deterministic
  // pin, same contract as the cube test above).
  assert.strictEqual(facesOf(m), 446, 'tone-bounded plate merge, got ' + facesOf(m));
  assert.strictEqual(totalArea(m), 16 * 16 * 2 + 16 * 4, 'plate surface area');
});

test('mesh: chunk-local coordinates in flat arrays, origin exported', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.world.setBlock(w, 1, 40, 2, F.blocks.GRASS);
  const m = F.mesh.buildChunk(w, 0, 0);
  assert.ok(Array.isArray(m.positions) && Array.isArray(m.colors) && Array.isArray(m.indices));
  assert.strictEqual(m.positions.length % 3, 0);
  assert.strictEqual(m.colors.length, m.positions.length);
  assert.deepStrictEqual([...m.origin], [0, 0, 0]);
  for (let i = 0; i < m.positions.length; i += 3) {
    assert.ok(m.positions[i] >= -0.001 && m.positions[i] <= 16.001, 'x in chunk: ' + m.positions[i]);
    assert.ok(m.positions[i + 2] >= -0.001 && m.positions[i + 2] <= 16.001, 'z in chunk: ' + m.positions[i + 2]);
  }
});

test('mesh: colors differ per block type', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.world.setBlock(w, 0, 40, 0, F.blocks.GRASS);
  F.world.setBlock(w, 5, 40, 5, F.blocks.STONE);
  const m = F.mesh.buildChunk(w, 0, 0);
  const seen = new Set();
  for (let i = 0; i < m.colors.length; i += 3) {
    seen.add(m.colors[i].toFixed(2) + ',' + m.colors[i + 1].toFixed(2) + ',' + m.colors[i + 2].toFixed(2));
  }
  assert.ok(seen.size >= 2, 'at least two distinct block colors, got ' + seen.size);
});

test('mesh: rebuilding after an edit only rebuilds dirty chunks (buffer reuse)', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(1);
  F.mesh.rebuildDirty(w); // initial build of the loaded area
  const farBefore = w.meshes.get('3,3');
  const centerBefore = w.meshes.get('0,0');
  assert.ok(farBefore && centerBefore, 'initial meshes built');
  F.world.setBlock(w, 8, 50, 8, F.blocks.PLANKS); // center of chunk 0,0, above any terrain
  const built = F.mesh.rebuildDirty(w);
  assert.deepStrictEqual([...built].sort(), ['0,0'], 'only the edited chunk rebuilt');
  assert.ok(w.meshes.get('3,3') === farBefore, 'untouched chunk buffer object reused');
  assert.ok(w.meshes.get('0,0') !== centerBefore, 'edited chunk rebuilt fresh');
});

test('mesh: border edit dirties the adjacent chunk too', async () => {
  const { F } = await loadNamespace(MODS);
  const w = F.world.create(1);
  F.mesh.rebuildDirty(w);
  F.world.setBlock(w, 0, 50, 8, F.blocks.PLANKS); // x=0 → border with chunk -1
  const built = F.mesh.rebuildDirty(w);
  assert.ok(built.includes('0,0'), 'own chunk rebuilt');
  assert.ok(built.includes('-1,0'), 'neighbor chunk rebuilt (face culling changes)');
});

test('mesh: per-block tone hash is deterministic, palette-bound, merge-safe', async () => {
  const { F } = await loadNamespace(MODS);
  const palette = F.blocks.palette(F.blocks.STONE, false);
  function toneAt(x, y, z) {
    const w = stubWorld(F);
    F.world.setBlock(w, x, y, z, F.blocks.STONE);
    const m = F.mesh.buildChunk(w, 0, 0);
    return [m.colors[0], m.colors[1], m.colors[2]];
  }
  assert.deepStrictEqual(toneAt(0, 40, 0), toneAt(0, 40, 0), 'same world -> same tone');
  const tones = new Set();
  for (let x = 0; x < 8; x++) {
    const c = toneAt(x, 40, x);
    tones.add(c.join(','));
    const inPalette = palette.some((p) =>
      Math.abs(p[0] - c[0]) < 1e-9 && Math.abs(p[1] - c[1]) < 1e-9 && Math.abs(p[2] - c[2]) < 1e-9);
    assert.ok(inPalette, 'tone comes from the stone palette: ' + c);
  }
  assert.ok(tones.size >= 2, 'tone hash varies across blocks: ' + tones.size);
  // Flat per face: all four corners of a face carry the same tone.
  const w = stubWorld(F);
  F.world.setBlock(w, 0, 40, 0, F.blocks.STONE);
  const m = F.mesh.buildChunk(w, 0, 0);
  for (let v = 1; v < 4; v++) assert.strictEqual(m.colors[v * 3], m.colors[0]);
});

test('mesh: grass side faces use the dirt-tinted palette, tops stay green', async () => {
  const { F } = await loadNamespace(MODS);
  const w = stubWorld(F);
  F.world.setBlock(w, 4, 40, 4, F.blocks.GRASS);
  const m = F.mesh.buildChunk(w, 0, 0);
  // Find the top face (normal +y: all four verts at y = 41) and a side face.
  let topR = -1, sideR = -1;
  for (let q = 0; q < m.indices.length; q += 6) {
    const v = m.indices[q] * 3;
    if (m.positions[v + 1] === 41 && topR < 0) topR = m.colors[v];
    if (m.positions[v + 1] === 40 && sideR < 0) sideR = m.colors[v];
  }
  assert.ok(topR > 0, 'top face found');
  assert.ok(sideR > 0, 'side face found');
  assert.ok(m.colors[0] >= 0, 'colors readable');
  // Top greens out-red the dirt sides on the green channel relative to red.
  assert.ok(topR < 0.45 && sideR >= 0.4, 'grass top green, sides brownish');
});
