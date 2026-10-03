'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/rng.js', 'game/noise.js', 'game/blocks.js', 'game/worldgen.js', 'game/world.js', 'game/eventlog.js', 'game/craft.js', 'game/survival.js', 'game/physics.js'];

// Synthetic flat world: bedrock at y=0, stone platform layer at y=20,
// everything else air. Deterministic — no terrain surprises.
const STAND_Y = 21.01;
function flatWorld(F) {
  const w = { seed: 1, chunks: {}, inventory: {}, dirty: new Set(), meshes: new Map(), logOps: [] };
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      const c = new Uint8Array(16 * 64 * 16);
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          c[F.worldgen.index(x, 0, z)] = F.blocks.BEDROCK;
          c[F.worldgen.index(x, 20, z)] = F.blocks.STONE;
        }
      }
      w.chunks[F.world.key(cx, cz)] = c;
    }
  }
  return w;
}

function spawn() {
  return { x: 0.5, y: STAND_Y, z: 0.5, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, flying: false };
}

test('physics: gravity lands the player on the platform and sets onGround', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  const p = spawn();
  p.y = 24; p.onGround = false;
  for (let i = 0; i < 240; i++) F.physics.step(p, {}, w, 1 / 60, 'survival');
  assert.ok(p.onGround, 'must settle on ground');
  assert.ok(Math.abs(p.y - STAND_Y) < 0.02, 'feet on platform: ' + p.y);
});

test('physics: jump leaves ground and returns', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  const p = spawn();
  let maxY = p.y;
  F.physics.step(p, { jump: true }, w, 1 / 60, 'survival');
  p.onGround = false;
  for (let i = 0; i < 120; i++) {
    F.physics.step(p, {}, w, 1 / 60, 'survival');
    maxY = Math.max(maxY, p.y);
  }
  assert.ok(maxY > STAND_Y + 0.5, 'jumped at least half a block: ' + (maxY - STAND_Y));
  assert.ok(p.onGround, 'landed again');
});

test('physics: walls stop walking — no clipping through solid blocks', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  // wall one block ahead (-x); yaw PI/2 faces -x
  for (let y = 21; y <= 23; y++) F.world.setBlock(w, -2, y, 0, F.blocks.STONE);
  const p = spawn();
  p.yaw = Math.PI / 2;
  for (let i = 0; i < 600; i++) F.physics.step(p, { forward: true }, w, 1 / 60, 'survival');
  assert.ok(p.x > -1.7, 'stopped at the wall, x=' + p.x);
  assert.ok(p.x < -0.5, 'moved toward the wall, x=' + p.x);
});

test('physics: dt clamp — a huge frame does not explode the sim (E3)', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  const p = spawn();
  p.y = 26; p.onGround = false;
  F.physics.step(p, {}, w, 3600, 'survival'); // backgrounded for an hour
  assert.ok(p.y > 19, 'did not tunnel through the world: y=' + p.y);
  assert.ok(p.y <= 26, 'did not launch upward');
});

test('physics: terminal-velocity jank frame lands instead of tunneling', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  const p = spawn();
  p.y = 26; p.onGround = false;
  p.vy = -50; // terminal fall speed, as after a long janky fall
  // One 250ms frame (rAF starved by a slow paint): 12.5 blocks of motion
  // in a single step. Without substepping moveAxis only checks the
  // destination and the player falls through the floor into the void.
  F.physics.step(p, {}, w, F.physics.DT_MAX, 'survival');
  assert.ok(p.onGround, 'landed on the platform, not tunneled');
  assert.ok(Math.abs(p.y - STAND_Y) < 0.02, 'feet on platform: ' + p.y);
});

test('physics: fly mode rises and ignores gravity', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  const p = spawn();
  p.flying = true;
  const y0 = p.y;
  for (let i = 0; i < 60; i++) F.physics.step(p, { jump: true }, w, 1 / 60, 'creative');
  assert.ok(p.y > y0 + 1, 'gained altitude in fly: ' + (p.y - y0));
});

test('physics: walking moves the player forward along yaw (yaw 0 → -z)', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  const p = spawn();
  for (let i = 0; i < 60; i++) F.physics.step(p, { forward: true }, w, 1 / 60, 'survival');
  assert.ok(p.z < 0.5 - 1, 'moved along -z by ' + (0.5 - p.z));
});

test('physics: sprint is faster than walk', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  const a = spawn();
  const b = spawn();
  for (let i = 0; i < 120; i++) F.physics.step(a, { forward: true }, w, 1 / 60, 'survival');
  for (let i = 0; i < 120; i++) F.physics.step(b, { forward: true, sprint: true }, w, 1 / 60, 'survival');
  const distA = Math.hypot(a.x - 0.5, a.z - 0.5);
  const distB = Math.hypot(b.x - 0.5, b.z - 0.5);
  assert.ok(distB > distA, 'sprint ' + distB + ' > walk ' + distA);
});

test('physics: landing event reports impact speed for fall damage', async () => {
  const { F } = await loadNamespace(MODS);
  const w = flatWorld(F);
  const p = spawn();
  p.y = 30; p.onGround = false;
  let landed = 0;
  for (let i = 0; i < 300; i++) {
    const r = F.physics.step(p, {}, w, 1 / 60, 'survival');
    if (r.landed > 0) landed = r.landed;
  }
  // fall from 9 blocks: v = sqrt(2*28*9) ≈ 22.5
  assert.ok(landed > 15, 'impact speed reported: ' + landed);
});
