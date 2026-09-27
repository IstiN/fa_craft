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

test('loop: rAF advances sim, day clock, and renders every frame', async () => {
  const { jsr } = await bootGame();
  const s0 = jsr.exported().dayTime;
  const rendersBefore = jsr.callCount('render');
 await jsr.pumpFrames(30, 16.6);
  assert.ok(jsr.exported().dayTime > s0, 'day time advances');
  assert.strictEqual(jsr.callCount('render') - rendersBefore, 30, 'one render per frame');
});

test('bridge budget: per-frame outbound calls stay bounded (IT)', async () => {
  const { jsr } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
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

test('voxel adapter: only dirty chunks upload meshes; camera each frame', async () => {
  const { jsr, sandbox } = await bootGame({ hostHandlers: { 'voxel.mesh': () => true, 'voxel.camera': () => true } });
  const F = sandbox.Facraft;
 await jsr.pumpFrames(5, 16.6);
  const meshes0 = jsr.callCount('hostCall:voxel.mesh');
  const cam0 = jsr.callCount('hostCall:voxel.camera');
 await jsr.pumpFrames(20, 16.6);
  assert.strictEqual(jsr.callCount('hostCall:voxel.mesh'), meshes0, 'no mesh upload without edits');
  assert.ok(jsr.callCount('hostCall:voxel.camera') - cam0 === 20, 'camera synced per frame');
  F.world.setBlock(F.state.world, 3, 60, 3, F.blocks.STONE);
 await jsr.pumpFrames(1, 16.6);
  assert.strictEqual(jsr.callCount('hostCall:voxel.mesh'), meshes0 + 1, 'one chunk upload after one edit');
 await jsr.pumpFrames(10, 16.6);
  assert.strictEqual(jsr.callCount('hostCall:voxel.mesh'), meshes0 + 1, 'no re-upload while clean');
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
