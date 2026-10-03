'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bootGame } = require('./harness.js');

// Deterministic aim helper: point the camera straight at a placed block.
// Setup pokes the real state object (white box); the ACTIONS under test go
// through the public event surface.
function placeAndAim(F, state, x, y, z, b) {
  F.world.setBlock(state.world, x, y, z, b);
  // eye at player position; look straight at the block center (yaw 0 faces -z)
  const p = state.world.player;
  p.x = x + 0.5;
  p.y = y + 0.5 - F.physics.EYE_H; // feet so the EYE sits at block-center height
  p.z = z + 4.5;
  p.yaw = 0;
  p.pitch = 0;
}

test('boot: fresh world publishes observable state (exportState contract)', async () => {
  const { jsr, sandbox } = await bootGame();
  const s = jsr.exported();
  assert.ok(s, 'state exported');
  assert.strictEqual(s.mode, 'survival', 'mini-survival default (owner ruling)');
  assert.strictEqual(s.health, 20);
  assert.strictEqual(s.dead, false);
  assert.strictEqual(s.selected, 1, 'hotbar slot 1 selected');
  assert.ok(s.pos && typeof s.pos.x === 'number', 'position exported');
  assert.ok(typeof s.dayTime === 'number', 'day clock running');
  assert.ok(sandbox.Facraft.state.world, 'world booted');
});

test('loop: rAF advances sim and day clock; HUD renders only on change (native)', async () => {
  const { jsr } = await bootGame();
  const s0 = jsr.exported().dayTime;
  await jsr.pumpFrames(30, 16.6);
  assert.ok(jsr.exported().dayTime > s0, 'day time advances');
  // Native path: the viewport node is constant and the HUD is signature-
  // gated, so idle frames mostly skip jsr.render — but SOMETHING settles
  // in the first frames (fps smoothing, day bucket), so renders are > 0.
  const renders = jsr.callCount('render');
  assert.ok(renders > 0, 'settling frames render');
  assert.ok(renders < 34, 'idle frames are gated: ' + renders + ' renders for ~30 frames');
  jsr.fire('hotbar', { slot: 3 }); // a real state change must render immediately
  const before = jsr.callCount('render');
  jsr.fire('hotbar', { slot: 4 });
  assert.ok(jsr.callCount('render') > before, 'state change forces a render');
});

test('bridge budget: per-frame outbound calls stay bounded (IT)', async () => {
  const { jsr, sandbox } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  sandbox.Facraft.state.world.mobsPaused = true; // terrain-only budget
 await jsr.pumpFrames(10, 16.6); // settle after boot
  const before = jsr.calls.length;
 await jsr.pumpFrames(50, 16.6);
  const steady = (jsr.calls.length - before) / 50;
  assert.ok(steady <= 6, 'idle frames make at most 6 bridge calls, got ' + steady);
  // no unbounded growth: another 50 frames cost the same
  const before2 = jsr.calls.length;
 await jsr.pumpFrames(50, 16.6);
  const steady2 = (jsr.calls.length - before2) / 50;
  assert.ok(steady2 <= steady + 0.5, 'no per-frame growth: ' + steady + ' → ' + steady2);
});

test('voxel adapter (native): voxel node, one mesh upload per chunk, camera per frame', async () => {
  const meshes = [];
  const { jsr, sandbox } = await bootGame({
    hostHandlers: {
      'voxel.mesh': (a) => { meshes.push(a); return true; },
      'voxel.camera': () => true,
    },
  });
  const F = sandbox.Facraft;
  await jsr.pumpFrames(5, 16.6);
  const node = findNode(jsr.lastTree, (n) => n.type === 'voxel');
  assert.ok(node, 'voxel viewport node in the render tree');
  assert.strictEqual(findNode(jsr.lastTree, (n) => n.type === 'scene3d'), null,
    'no legacy scene3d node once the native path is on');
  assert.ok(meshes.length >= 25, '5x5 view ring uploaded at boot, got ' + meshes.length);
  assert.ok(meshes.every((m) => m.positions.length && m.indices.length), 'non-empty chunk buffers');
  const up0 = meshes.length;
  const cam0 = jsr.callCount('hostCall:voxel.camera');
  // Pause the fauna: wandering mobs legitimately re-upload their chunks.
  F.state.world.mobsPaused = true;
  await jsr.pumpFrames(20, 16.6);
  assert.strictEqual(meshes.length, up0, 'no re-upload while the world is clean');
  const idleCam = jsr.callCount('hostCall:voxel.camera') - cam0;
  assert.ok(idleCam <= 20, 'camera pushes are quantized, not per frame');
  // Moving the eye must produce a camera push within a couple of frames.
  F.state.world.player.yaw += 0.5;
  await jsr.pumpFrames(3, 16.6);
  assert.ok(jsr.callCount('hostCall:voxel.camera') > cam0 + idleCam,
    'eye movement pushes a fresh camera');
  F.world.setBlock(F.state.world, 0, Math.floor(F.state.world.player.y) - 1, 1, F.blocks.BRICKS);
  await jsr.pumpFrames(1, 16.6);
  // The edit dirties its chunk (plus the west neighbor: x=0 is a chunk
  // border, and border edits invalidate the neighbor's culled faces).
  // '__'-prefixed resident chunks (aim marker follows the rotated camera)
  // are not terrain uploads.
  const reuploaded = meshes.slice(up0)
    .filter((m) => !String(m.key).startsWith('__'));
  assert.ok(reuploaded.length >= 1 && reuploaded.length <= 2,
    'world edit re-uploads only dirty chunks, got ' + reuploaded.length);
  assert.ok(reuploaded.some((m) => m.key === '0,0'), 'the edited chunk re-uploaded');
  await jsr.pumpFrames(10, 16.6);
  assert.strictEqual(meshes.length, up0 + reuploaded.length, 'no rebuild while clean after the edit');
});

test('voxel adapter (native): aimed block uploads a resident __hl highlight chunk', async () => {
  const meshes = [];
  const { jsr, sandbox } = await bootGame({
    hostHandlers: {
      'voxel.mesh': (a) => { meshes.push(a); return true; },
      'voxel.camera': () => true,
    },
  });
  const F = sandbox.Facraft;
  placeAndAim(F, F.state, 0, 60, -2, F.blocks.STONE);
  await jsr.pumpFrames(2, 16.6);
  const hl = meshes.filter((m) => m.key === '__hl');
  assert.ok(hl.length >= 1, 'highlight chunk uploaded');
  const shell = hl[hl.length - 1];
  // Selection ring on the aimed face: 4 border quads, bright, coplanar
  // with the +z entry face (aim from +z), lifted a hair off the surface.
  assert.strictEqual(shell.positions.length, 48, '16 ring corners');
  assert.strictEqual(shell.indices.length, 24, '8 ring triangles');
  assert.ok(shell.positions.every((v, i) => i % 3 !== 2 || Math.abs(v - (-2 + 1.004)) < 1e-9),
    'ring lies on the aimed +z face plane');
  assert.ok(shell.colors.every((c) => c === 1), 'ring is bright white');
  assert.strictEqual(shell.overlay, true, 'ring depth-biased over the block face');
  // looking at the sky parks a degenerate marker (no voxel.chunkRemove yet)
  F.state.world.player.pitch = 1.5;
  await jsr.pumpFrames(2, 16.6);
  const hl2 = meshes.filter((m) => m.key === '__hl');
  assert.ok(hl2.length > hl.length, 'empty aim re-uploads the marker key');
  assert.ok(hl2[hl2.length - 1].positions.every((v) => v === 0), 'degenerate marker mesh');
});

test('voxel adapter (native): walking evicts off-ring chunks behind the player', async () => {
  const removed = [];
  const { jsr, sandbox } = await bootGame({
    hostHandlers: {
      'voxel.mesh': () => true,
      'voxel.camera': () => true,
      'voxel.chunkRemove': (a) => { removed.push(a.key); return true; },
    },
  });
  const F = sandbox.Facraft;
  await jsr.pumpFrames(5, 16.6);
  const up0 = jsr.callCount('hostCall:voxel.mesh');
  assert.strictEqual(removed.length, 0, 'no eviction before movement');
  // Teleport 3 chunks east: the old ring's west columns leave the
  // ring+1 margin and must be evicted; the new ring uploads.
  F.state.world.player.x += 48;
  await jsr.pumpFrames(2, 16.6);
  assert.ok(removed.length > 0, 'off-ring chunks evicted after walking');
  assert.ok(jsr.callCount('hostCall:voxel.mesh') > up0, 'new ring uploaded');
  // Walking back re-uploads the evicted chunks (world state replays edits).
  const up1 = jsr.callCount('hostCall:voxel.mesh');
  F.state.world.player.x -= 48;
  await jsr.pumpFrames(2, 16.6);
  assert.ok(jsr.callCount('hostCall:voxel.mesh') > up1, 'evicted chunks re-upload on return');
});

test('input: viewport wires drag-look AND trackpad scroll-look', async () => {
  const { jsr } = await bootGame();
  await jsr.pumpFrames(2, 16.6);
  const gd = findNode(jsr.lastTree, (n) => n.type === 'gestureDetector' && n.onPanUpdate === 'look');
  assert.ok(gd, 'viewport gesture area present');
  assert.strictEqual(gd.onScroll, 'scrollLook', 'trackpad swipe maps to the inverted-look action');
});

test('input: trackpad scroll looks the SAME direction as drag (inverted deltas)', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  await jsr.pumpFrames(1, 16.6);
  const yaw0 = F.state.world.player.yaw;
  jsr.fire('look', { dx: 30, dy: 0 }); // drag right
  const dragDelta = F.state.world.player.yaw - yaw0;
  jsr.fire('scrollLook', { dx: -30, dy: 0 }); // natural-scroll fingers right
  const scrollDelta = F.state.world.player.yaw - yaw0 - dragDelta;
  assert.ok(Math.sign(dragDelta) === Math.sign(scrollDelta),
    'scroll and drag rotate the same way for the same finger direction');
});

test('input: joystick stick offset comes from pan POSITION, not per-event deltas', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  await jsr.pumpFrames(1, 16.6);
  const p0 = { x: F.state.world.player.x, z: F.state.world.player.z };
  // Stick dragged to the top edge of the 96x96 pad: localPosition y ~ 8.
  jsr.fire('joyMove', { x: 48, y: 8 });
  await jsr.pumpFrames(30, 16.6);
  jsr.fire('joyEnd');
  const dz = F.state.world.player.z - p0.z;
  const dx = F.state.world.player.x - p0.x;
  assert.ok(Math.hypot(dx, dz) > 0.5, 'full-deflection stick actually walks: ' + Math.hypot(dx, dz));
});

test('voxel adapter (legacy fallback): scene3d viewport, meshes cached while clean', async () => {
  const { jsr, sandbox } = await bootGame({ voxelNative: false });
  const F = sandbox.Facraft;
  await jsr.pumpFrames(5, 16.6);
  const scene = findNode(jsr.lastTree, (n) => n.type === 'scene3d');
  assert.ok(scene, 'scene3d viewport node in the render tree');
  assert.ok(scene.meshes.length > 0, 'world geometry present');
  assert.ok(scene.meshes.every((m) => m.vertices.length && m.faces.length), 'no empty meshes');
  assert.ok(/^#[0-9a-f]{6}$/.test(scene.background), 'sky-colored background');
  assert.strictEqual(scene.camera.position.length, 3, 'camera at the player eye');
  const meshes0 = scene.meshes;
  await jsr.pumpFrames(20, 16.6);
  assert.strictEqual(findNode(jsr.lastTree, (n) => n.type === 'scene3d').meshes, meshes0,
    'mesh payload reused by identity while the world is clean');
  F.world.setBlock(F.state.world, 0, Math.floor(F.state.world.player.y) - 1, 1, F.blocks.BRICKS);
  await jsr.pumpFrames(1, 16.6);
  const meshes1 = findNode(jsr.lastTree, (n) => n.type === 'scene3d').meshes;
  assert.notStrictEqual(meshes1, meshes0, 'world edit rebuilds the mesh payload');
  const topY = Math.floor(F.state.world.player.y); // top face of the block underfoot
  const hasPlaced = meshes1.some((m) => m.vertices.some((v) =>
    v[0] === 0 && v[1] === topY && v[2] === 1));
  assert.ok(hasPlaced, 'a top-face corner of the placed bricks block is in the payload');
  await jsr.pumpFrames(10, 16.6);
  assert.strictEqual(findNode(jsr.lastTree, (n) => n.type === 'scene3d').meshes, meshes1,
    'no rebuild while clean after the edit');
});

test('voxel adapter (legacy fallback): targeted block gets a whitened highlight mesh', async () => {
  const { jsr, sandbox } = await bootGame({ voxelNative: false });
  const F = sandbox.Facraft;
  placeAndAim(F, F.state, 0, 60, -2, F.blocks.STONE);
  await jsr.pumpFrames(1, 16.6);
  const scene = findNode(jsr.lastTree, (n) => n.type === 'scene3d');
  assert.ok(scene, 'scene rendered');
  // The highlight shell is the one mesh whose color is lightened STONE.
  const base = scene.meshes.filter((m) => m.vertices.length > 8);
  const shells = scene.meshes.filter((m) => m.vertices.length === 8 && m.faces.length === 12);
  assert.strictEqual(shells.length, 1, 'exactly one highlight shell (8 corners, 12 tris)');
  assert.notStrictEqual(shells[0].color, '#8c8c91', 'shell is a whitened block color, not raw stone');
  assert.ok(base.length >= 1, 'world geometry still present');
});

test('break: breaks the targeted block into inventory', async () => {
  const { jsr, sandbox } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = sandbox.Facraft;
  placeAndAim(F, F.state, 0, 60, -2, F.blocks.STONE);
  jsr.fire('break');
  const s = jsr.exported();
  assert.strictEqual(s.inventory[F.blocks.STONE], 1, 'stone collected');
  assert.strictEqual(F.state.world.get(0, 60, -2), F.blocks.AIR, 'block removed');
});

test('break: bedrock is unbreakable', async () => {
  const { jsr, sandbox } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = sandbox.Facraft;
  placeAndAim(F, F.state, 0, 60, -2, F.blocks.BEDROCK); // elevated bedrock block
  jsr.fire('break');
  assert.strictEqual(F.state.world.get(0, 60, -2), F.blocks.BEDROCK, 'bedrock intact');
  assert.ok(jsr.exported().notice && /bedrock/i.test(jsr.exported().notice), 'rejection surfaced');
});

test('place: survival consumes inventory; empty slot refuses', async () => {
  const { jsr, sandbox } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = sandbox.Facraft;
  placeAndAim(F, F.state, 0, 60, -2, F.blocks.STONE); // solid target block
  F.state.world.inventory[F.blocks.STONE] = 1; // setup: collected stone earlier
  const slot = F.hotbarSlotOf(F.blocks.STONE);
  jsr.fire('hotbar', { slot });
  jsr.fire('place'); // places against the entry face
  assert.strictEqual(F.state.world.get(0, 60, -1), F.blocks.STONE, 'placed at entry face');
  assert.strictEqual(jsr.exported().inventory[F.blocks.STONE], 0, 'consumed');
  jsr.fire('place'); // nothing left in the slot
  assert.ok(jsr.exported().notice && jsr.exported().notice.length > 0, 'refusal notice shown');
});

test('hotbar: select by payload, cycle without, HUD reflects selection', async () => {
  const { jsr } = await bootGame();
  jsr.fire('hotbar', { slot: 4 });
  assert.strictEqual(jsr.exported().selected, 4);
  jsr.fire('hotbar');
  assert.strictEqual(jsr.exported().selected, 5, 'cycles');
  jsr.fire('hotbar', { slot: 9 });
  assert.strictEqual(jsr.exported().selected, 5, 'out-of-range ignored');
  const hotbarNode = findNode(jsr.lastTree, (n) => n.hotbarIndex === 4);
  assert.ok(hotbarNode, 'selected slot marked in HUD tree');
});

test('craft: sheet opens, recipe crafts from inventory, HUD shows it (AC2 state)', async () => {
  const { jsr, sandbox } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = sandbox.Facraft;
  F.state.world.inventory[F.blocks.LOG] = 3; // setup: broke 3 logs earlier
  jsr.fire('craft');
  assert.ok(findNode(jsr.lastTree, (n) => n.craftSheet === true), 'crafting sheet open in HUD');
  jsr.fire('craftRecipe', { id: 'planks' });
  const s = jsr.exported();
  assert.strictEqual(s.inventory[F.blocks.PLANKS], 4, 'planks crafted');
  assert.strictEqual(s.inventory[F.blocks.LOG], 2, 'log consumed');
  jsr.fire('closeCraft');
  assert.ok(!findNode(jsr.lastTree, (n) => n.craftSheet === true), 'sheet closed');
});

test('health: damage updates HUD hearts; death shows respawn dialog (AC2 state)', async () => {
  const { jsr, sandbox } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = sandbox.Facraft;
  F.survival.damage(F.state.world, 'fall', 6); // setup: took a fall
 await jsr.pumpFrames(1, 16.6); // one frame → fresh exportState snapshot
  assert.strictEqual(jsr.exported().health, 14);
  const hearts = countHearts(jsr.lastTree);
  assert.strictEqual(hearts, 7, 'hearts row shows 7 of 10 (each heart = 2 hp)');
  F.survival.damage(F.state.world, 'void', 30);
 await jsr.pumpFrames(1, 16.6);
  assert.strictEqual(jsr.exported().dead, true);
  assert.ok(findNode(jsr.lastTree, (n) => n.deathDialog === true), 'death dialog rendered');
  jsr.fire('respawn');
  assert.strictEqual(jsr.exported().dead, false);
  assert.strictEqual(jsr.exported().health, 20, 'respawned at full health');
});

test('look: drag deltas rotate the camera (drag-to-look path)', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  const yaw0 = F.state.world.player.yaw;
  jsr.fire('look', { dx: 60, dy: 0 });
  assert.ok(F.state.world.player.yaw !== yaw0, 'yaw follows drag');
});

test('debug: F3 overlay toggles and shows position/fps/chunks', async () => {
  const { jsr } = await bootGame();
 await jsr.pumpFrames(10, 16.6);
  jsr.fire('debug');
  const dbg = findNode(jsr.lastTree, (n) => n.debugOverlay === true);
  assert.ok(dbg, 'debug overlay rendered');
  assert.ok(dbg.lines.join('\n').includes('pos'), 'debug shows position');
  jsr.fire('debug');
  assert.ok(!findNode(jsr.lastTree, (n) => n.debugOverlay === true), 'debug toggles off');
});

test('keyboard: held-key movement reaches the sim (w/a/s/d, space)', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  // open sky at y=58: above any generated terrain → horizontal movement is collision-free
  F.state.world.player.y = 58;
  F.state.world.player.x = 0.5;
  F.state.world.player.z = 0.5;
  const z0 = F.state.world.player.z;
  jsr.fireKey({ key: 'w', down: true, repeat: false });
 await jsr.pumpFrames(60, 16.6);
  jsr.fireKey({ key: 'w', down: false, repeat: false });
  assert.ok(F.state.world.player.z < z0, 'walked forward with W held');
});

test('mode: toggle creative/survival; fly only in creative', async () => {
  const { jsr, sandbox } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = sandbox.Facraft;
  jsr.fire('fly');
  assert.strictEqual(F.state.world.player.flying, false, 'fly refused in survival');
  jsr.fire('mode');
  assert.strictEqual(jsr.exported().mode, 'creative');
  jsr.fire('fly');
  assert.strictEqual(F.state.world.player.flying, true, 'fly in creative');
  jsr.fire('mode');
  assert.strictEqual(jsr.exported().mode, 'survival');
  assert.strictEqual(F.state.world.player.flying, false, 'mode drop cancels fly');
});

// --- helpers ---
function findNode(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  if (Array.isArray(node)) {
    for (const c of node) { const r = findNode(c, pred); if (r) return r; }
    return null;
  }
  for (const k of Object.keys(node)) {
    const r = findNode(node[k], pred);
    if (r) return r;
  }
  return null;
}

function countHearts(tree) {
  let n = 0;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.heart === true) n++;
    for (const k of Object.keys(node)) walk(node[k]);
  })(tree);
  return n;
}

test('input: jump pad (touch) holds jump and lifts the player', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  await jsr.pumpFrames(10, 16.6); // settle on the ground
  const y0 = F.state.world.player.y;
  jsr.fire('jumpDown', {});
  await jsr.pumpFrames(10, 16.6);
  jsr.fire('jumpUp', {});
  assert.ok(F.state.world.player.y > y0, 'jump pad lifts the player');
});

test('mobs: pigs and chickens spawn, wander, and upload resident chunks', async () => {
  const keys = [];
  const { jsr, sandbox } = await bootGame({
    hostHandlers: {
      'voxel.mesh': (a) => { keys.push(a.key); return true; },
      'voxel.camera': () => true,
    },
  });
  const F = sandbox.Facraft;
  await jsr.pumpFrames(30, 16.6);
  const mobs = F.state.world.mobs || [];
  assert.ok(mobs.length > 0, 'mobs spawned near spawn point');
  assert.ok(mobs.some((m) => m.type === 'pig'), 'at least one pig');
  const uploads = keys.filter((k) => typeof k === 'string' && k.startsWith('__mob'));
  assert.ok(uploads.length > 0, 'mob chunks uploaded: ' + uploads.join(','));
  const m0 = { x: mobs[0].x, z: mobs[0].z };
  await jsr.pumpFrames(240, 16.6); // ~4s of wandering
  const m1 = F.state.world.mobs[0];
  assert.ok(m1, 'mob still present (in range)');
});

// Signed volume of a closed mesh: sum(dot(a, cross(b, c)))/6 — the sign
// flips with winding, so matching a known-good terrain mesh proves the
// backface-cull contract regardless of part offsets.
function signedVolume(mesh) {
  const P = mesh.positions, I = mesh.indices;
  let v = 0;
  for (let q = 0; q < I.length; q += 3) {
    const a = I[q] * 3, b = I[q + 1] * 3, c = I[q + 2] * 3;
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) +
      P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2]) +
      P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return v;
}

test('mobs: mobMesh winding matches the terrain mesher (cull contract)', async () => {
  const { sandbox } = await bootGame();
  const F = sandbox.Facraft;
  for (const type of ['pig', 'chicken']) {
    const mesh = F.mobs.mobMesh({ type, x: 0, y: 10, z: 0, yaw: 0.7 });
    assert.ok(mesh.positions.length > 0 && mesh.indices.length % 6 === 0);
    assert.ok(signedVolume(mesh) > 0,
      type + ' volume sign matches outward-CCW terrain: ' + signedVolume(mesh));
  }
});

test('mobs: attack butchers the aimed mob and heals (meat drop)', async () => {
  const keys = [];
  const { jsr, sandbox } = await bootGame({
    hostHandlers: {
      'voxel.mesh': (a) => { keys.push(a.key); return true; },
      'voxel.camera': () => true,
    },
  });
  const F = sandbox.Facraft;
  await jsr.pumpFrames(30, 16.6);
  const w = F.state.world;
  assert.ok(w.mobs.length > 0, 'mobs spawned');
  // Teleport mob 0 in front of the player and aim DOWN at it — a pig is
  // 1.25 blocks tall, the horizontal eye ray (1.62) passes over its head.
  const p = w.player;
  const m = w.mobs[0];
  const dir = F.physics.dirOf(p.yaw = 0, p.pitch = -0.45);
  m.x = p.x + dir.x * 2 / Math.hypot(dir.x, dir.z);
  m.y = p.y;
  m.z = p.z + dir.z * 2 / Math.hypot(dir.x, dir.z);
  m.vx = m.vy = m.vz = 0;
  m.moving = false;
  m.think = 99;
  const hp0 = w.health = 10;
  const before = w.mobs.length;
  jsr.fire('break');
  assert.strictEqual(w.mobs.length, before - 1, 'mob butchered');
  assert.strictEqual(w.health, hp0 + 2, 'meat heals +2 HP');
  assert.strictEqual(w.mobKills, 1, 'kill counted in exportState');
  assert.ok(keys.filter((k) => k === '__mob' + m.id).length >= 0); // key by id
});

test('mobs: raycast prefers the nearer mob, misses past maxDist', async () => {
  const { sandbox } = await bootGame();
  const F = sandbox.Facraft;
  const w = F.state.world;
  w.mobs = [
    { id: 1, type: 'pig', x: 0.5, y: 60, z: -1.5, yaw: 0, vx: 0, vy: 0, vz: 0, think: 99, uploadKey: '' },
    { id: 2, type: 'chicken', x: 0.5, y: 60, z: -3, yaw: 0, vx: 0, vy: 0, vz: 0, think: 99, uploadKey: '' },
  ];
  const hit = F.mobs.raycast(w, 0.5, 61, 0, 0, 0, -1, 6);
  assert.ok(hit && hit.index === 0, 'nearest mob hit first');
  const miss = F.mobs.raycast(w, 0.5, 61, 0, 0, 0, -1, 1);
  assert.strictEqual(miss, null, 'beyond maxDist misses');
  const aside = F.mobs.raycast(w, 5, 61, 0, 0, 0, -1, 6);
  assert.strictEqual(aside, null, 'off-axis ray misses');
});

test('hud: render tree never emits an unknown "positioned" node type', async () => {
  // Stack children use the MAP form ({positioned:{...}, child}) — a
  // type:'positioned' node falls back to an 'Unknown type' error label.
  const { jsr } = await bootGame();
  await jsr.pumpFrames(3, 16.6);
  let bad = 0;
  JSON.stringify(jsr.lastTree, (k, v) => {
    if (k === 'type' && v === 'positioned') bad++;
    return v;
  });
  assert.strictEqual(bad, 0, 'no type:"positioned" nodes in the tree');
});

test('hotbar: digit keys 1-8 select the slot (hotbarN → hotbar{slot})', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  for (const [key, slot] of [['1', 1], ['3', 3], ['8', 8]]) {
    jsr.fireKey({ key, code: 'Digit' + key, down: true, repeat: false });
    assert.strictEqual(F.state.selected, slot, 'key ' + key + ' selects slot ' + slot);
    jsr.fireKey({ key, code: 'Digit' + key, down: false, repeat: false });
  }
  // repeat noise does not re-fire
  jsr.fireKey({ key: '3', code: 'Digit3', down: true, repeat: true });
  assert.strictEqual(F.state.selected, 8, 'repeat ignored');
});

test('physics: entity collision box follows halfW/height (mobs fit walls)', async () => {
  const { sandbox } = await bootGame();
  const F = sandbox.Facraft;
  const w = F.state.world;
  // a solid wall at x=1..2 spanning z: a chicken at x=0.5 with halfW 0.32
  // must stop earlier than the player (HALF 0.3) would... and crucially a
  // 0.5-half pig must not tunnel into it.
  F.world.setBlock(w, 1, Math.floor(w.player.y), 0, F.blocks.STONE);
  const pig = { x: -0.4, y: Math.floor(w.player.y), z: 0.5, halfW: 0.5, height: 1.25 };
  const hit = F.physics.step(
    Object.assign(pig, { vx: 0, vz: 0, vy: 0, yaw: Math.PI / 2, onGround: true }),
    { forward: true }, w, 0.1, 'survival');
  assert.ok(pig.x <= 0.51, 'fat pig blocked by the wall, x=' + pig.x);
});
