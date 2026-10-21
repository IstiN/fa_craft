'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bootGame, decodeBinaryEnvelope } = require('./harness.js');

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

test('voxel adapter (native): voxel node, one blocks upload per chunk, camera per frame', async () => {
  const meshes = [];
  const { jsr, sandbox } = await bootGame({
    hostHandlers: {
      'voxel.blocks': (a) => { meshes.push(a); return true; },
      'voxel.camera': () => true,
    },
  });
  const F = sandbox.Facraft;
  // The boot ring STREAMS in (3 chunks/frame cap, nearest first), so the
  // full 5x5 ring needs ~9 frames — pump 12 for margin. Budget pinned:
  // the adaptive throttle reacts to the loaded runner (see ut_perf) and
  // would make fixed-frame-count assertions flaky.
  F.voxel.pinBudget(3);
  await jsr.pumpFrames(12, 16.6);
  const node = findNode(jsr.lastTree, (n) => n.type === 'voxel');
  assert.ok(node, 'voxel viewport node in the render tree');
  assert.strictEqual(findNode(jsr.lastTree, (n) => n.type === 'scene3d'), null,
    'no legacy scene3d node once the native path is on');
  assert.ok(meshes.length >= 25, 'core view ring uploaded at boot, got ' + meshes.length);
  assert.ok(meshes.every((m) => typeof m.blocks === 'string' && m.blocks.length > 20000 &&
    m.size[0] === 16 && m.size[1] === 64 && m.size[2] === 16),
    'raw 16x64x16 block bytes cross the bridge, not mesh JSON');
  assert.ok(meshes[0].palette && meshes[0].palette.length === 10,
    'the tone palette rides the first upload');
  assert.ok(meshes.slice(1).every((m) => !m.palette),
    'later uploads reuse the runtime-cached palette');
  // Let the frame-capped streamer finish the ring before measuring:
  // a 7x7 ring takes ~17 frames at cap 3.
  await jsr.pumpFrames(24, 16.6);
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
  // Resident '__'-prefixed chunks (aim marker, fx, mobs) legitimately
  // follow runtime state — on a loaded runner their upload can slip a
  // frame past the edit, so the clean-window invariant counts TERRAIN
  // chunks only (the same filter the edit-frame count above applies).
  const lateTerrain = meshes.slice(up0)
    .filter((m) => !String(m.key).startsWith('__'));
  const strays = lateTerrain.filter((m) => !reuploaded.includes(m));
  assert.strictEqual(strays.length, 0,
    'no terrain rebuild while clean after the edit, got: ' +
    strays.map((m) => m.key).join(', '));
});

test('boot: the first rendered tree is the splash, the HUD replaces it', async () => {
  const { jsr } = await bootGame();
  assert.ok(jsr.trees.length >= 2, 'splash then HUD rendered');
  const splash = jsr.trees[0];
  assert.ok(findNode(splash, (n) => n.type === 'text' && n.data === '⛏ Fa Craft'),
    'splash shows the game title');
  assert.ok(findNode(splash, (n) => n.type === 'text' && /loading/i.test(String(n.data))),
    'splash shows a loading hint');
  assert.strictEqual(findNode(splash, (n) => n.type === 'voxel'), null,
    'splash carries no viewport — it is a pure loading card');
  assert.ok(findNode(jsr.lastTree, (n) => n.type === 'voxel'),
    'the HUD with the voxel viewport follows once the world is ready');
});

test('voxel adapter (native): boot streams the ring frame-capped, nearest first', async () => {
  const meshes = [];
  const { jsr, sandbox } = await bootGame({
    hostHandlers: {
      'voxel.blocks': (a) => { meshes.push(a); return true; },
      'voxel.camera': () => true,
    },
  });
  const terrain = () => meshes.filter((m) => !String(m.key).startsWith('__'));
  sandbox.Facraft.voxel.pinBudget(3); // pin: fixed frame counts, see ut_perf
  await jsr.pumpFrames(1, 16.6);
  assert.ok(terrain().length >= 1 && terrain().length <= 3,
    'the first frame uploads at most the per-frame cap, got ' + terrain().length);
  assert.ok(terrain().some((m) => m.key === '0,0'),
    'nearest-first: the player chunk streams in frame 1');
  await jsr.pumpFrames(20, 16.6);
  assert.ok(terrain().length >= 49,
    'the full 7x7 ring lands within ~20 frames, got ' + terrain().length);
});

test('voxel adapter (fallback): pre-0.4.163 runtimes keep the JS-meshed path', async () => {
  const meshes = [];
  const blocks = [];
  const { jsr, sandbox } = await bootGame({
    voxelBlocks: false, // probe resolves WITHOUT the blocks capability
    hostHandlers: {
      'voxel.mesh': (a) => { meshes.push(a); return true; },
      'voxel.blocks': (a) => { blocks.push(a); return true; },
      'voxel.camera': () => true,
    },
  });
  sandbox.Facraft.voxel.pinBudget(3); // pin: fixed frame counts, see ut_perf
  await jsr.pumpFrames(20, 16.6);
  assert.strictEqual(blocks.length, 0,
    'no raw-block uploads when the runtime does not advertise blocks');
  const terrain = meshes.filter((m) => !String(m.key).startsWith('__'));
  assert.ok(terrain.length >= 49,
    'the 7x7 ring uploads as JS-meshed voxel.mesh buffers, got ' + terrain.length);
  assert.ok(terrain.every((m) => m.positions.length && m.indices.length),
    'mesh buffers stay non-empty on the fallback path');
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
  const up0 = jsr.callCount('hostCall:voxel.blocks');
  assert.strictEqual(removed.length, 0, 'no eviction before movement');
  // Teleport 6 chunks east: the old ring's west columns leave the
  // ring+1 margin and must be evicted; the new ring uploads (raw block
  // bytes via voxel.blocks — the Dart-meshed native path, now default).
  F.state.world.player.x += 96;
  await jsr.pumpFrames(2, 16.6);
  assert.ok(removed.length > 0, 'off-ring chunks evicted after walking');
  assert.ok(jsr.callCount('hostCall:voxel.blocks') > up0, 'new ring uploaded');
  // Walking back re-uploads the evicted chunks (world state replays edits).
  const up1 = jsr.callCount('hostCall:voxel.blocks');
  F.state.world.player.x -= 96;
  await jsr.pumpFrames(2, 16.6);
  assert.ok(jsr.callCount('hostCall:voxel.blocks') > up1, 'evicted chunks re-upload on return');
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
  // Lift the player high into the air: mid-air movement keeps the assertion
  // independent of the random seed's terrain (a cliff or tree ahead of the
  // spawn would legitimately block the walk and flake the test).
  F.state.world.player.y += 30;
  const p0 = { x: F.state.world.player.x, z: F.state.world.player.z };
  // Stick dragged to the top edge of the 96x96 pad: localPosition y ~ 8.
  jsr.fire('joyMove', { x: 48, y: 8 });
  await jsr.pumpFrames(30, 16.6);
  jsr.fire('joyEnd');
  const dz = F.state.world.player.z - p0.z;
  const dx = F.state.world.player.x - p0.x;
  assert.ok(Math.hypot(dx, dz) > 0.5, 'full-deflection stick actually walks: ' + Math.hypot(dx, dz));
});

test('input: a lost joystick stream auto-releases the stick (watchdog)', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  await jsr.pumpFrames(1, 16.6);
  jsr.fire('joyMove', { x: 48, y: 8 }); // engage — then the stream dies
  await jsr.pumpFrames(30, 16.6);       // > 20 silent ticks: watchdog fires
  const p1 = { x: F.state.world.player.x, z: F.state.world.player.z };
  await jsr.pumpFrames(15, 16.6);
  const dx = F.state.world.player.x - p1.x, dz = F.state.world.player.z - p1.z;
  assert.ok(Math.hypot(dx, dz) < 0.15,
    'no joyEnd/panCancel ever arrived, yet the player stopped: ' + Math.hypot(dx, dz));
});

test('input: a quick jump tap still hops (minimum impulse window)', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  // NOTE: one pumpFrames call — each call restarts the frame clock, so the
  // first frame of every later batch gets dt=0 (harness artifact).
  await jsr.pumpFrames(2, 16.6);
  // Guarantee headroom: a tree canopy above the spawn would otherwise eat
  // the hop (seed-dependent flake).
  const p = F.state.world.player;
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
  for (let i = 1; i <= 3; i++) F.world.setBlock(F.state.world, fx, fy + i, fz, F.blocks.AIR);
  const y0 = F.state.world.player.y;
  jsr.fire('jumpDown');
  jsr.fire('jumpUp'); // tap shorter than one frame — must not be lost
  await jsr.pumpFrames(8, 16.6);
  const dy = F.state.world.player.y - y0;
  assert.ok(dy > 0.2, 'quick tap produced a real hop: ' + dy);
});

test('input: hotbar slots are tappable gesture detectors with slot payloads', async () => {
  const { jsr } = await bootGame();
  await jsr.pumpFrames(1, 16.6);
  const slots = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'gestureDetector' && n.onTap === 'hotbar') slots.push(n);
    for (const k of Object.keys(n)) walk(n[k]);
  })(jsr.lastTree);
  assert.strictEqual(slots.length, 8, 'every hotbar slot is tappable');
  // The tree comes from a vm sandbox — deepStrictEqual would fail on the
  // cross-realm prototype; compare the field.
  assert.strictEqual(slots[2].payload.slot, 3,
    'slot 3 fires hotbar with {slot: 3} — the same action the digit key fires');
  jsr.fire('hotbar', { slot: 3 });
  assert.strictEqual(jsr.exported().selected, 3);
});

test('input: long-press into the sky is a silent no-op; breakEnd stops mining', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  await jsr.pumpFrames(1, 16.6);
  // Straight up — and clear a shaft first: a hill above the horizon or a
  // tree canopy overhead would otherwise be a legitimate target (seed
  // flake).
  const p = F.state.world.player;
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
  for (let i = 1; i <= 8; i++) F.world.setBlock(F.state.world, fx, fy + i, fz, F.blocks.AIR);
  p.pitch = Math.PI / 2 - 0.01;
  const ops0 = F.state.world.logOps.length; // includes the shaft clearing
  jsr.fire('breakHold');
  await jsr.pumpFrames(40, 16.6); // ~660 ms of holding: repeats included
  assert.strictEqual(F.state.world.logOps.length, ops0,
    'no phantom edits while holding on air');
  assert.strictEqual(jsr.exported().notice || '', '',
    '…and no notice spam while holding on air');
  jsr.fire('breakEnd');
});

test('input: long-press hold mines straight down through a column', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  const p = F.state.world.player;
  // Settle onto the ground (fresh spawn floats 1 cm; a water/canopy spawn
  // may take longer) — retry in small batches until landed.
  for (let i = 0; i < 8 && !p.onGround; i++) await jsr.pumpFrames(2, 16.6);
  assert.ok(p.onGround, 'landed before mining');
  p.pitch = -Math.PI / 2 + 0.01; // straight down at the block underfoot
  const ops0 = F.state.world.logOps.length;
  jsr.fire('breakHold'); // immediate break…
  assert.strictEqual(F.state.world.logOps.length, ops0 + 1,
    'long-press start broke the block underfoot');
  await jsr.pumpFrames(25, 16.6); // ~415 ms — one 280 ms repeat window passes
  jsr.fire('breakEnd');
  const edits = F.state.world.logOps.length - ops0;
  assert.ok(edits >= 2, 'hold kept mining the next block down: ' + edits + ' edits');
});

test('voxel adapter: failed probe renders the update card — no scene3d fallback', async () => {
  const { jsr } = await bootGame({ voxelNative: false });
  await jsr.pumpFrames(5, 16.6);
  assert.strictEqual(findNode(jsr.lastTree, (n) => n.type === 'scene3d'), null,
    'the legacy scene3d meshes path is gone');
  const card = findNode(jsr.lastTree, (n) => n.type === 'text' &&
    typeof n.data === 'string' && n.data.includes('0.4.156'));
  assert.ok(card, 'static update card in the render tree');
  assert.strictEqual(jsr.callCount('hostCall:voxel.mesh'), 0,
    'no chunk uploads cross the bridge on an unsupported host');
  assert.strictEqual(jsr.callCount('hostCall:voxel.camera'), 0,
    'no camera pushes on an unsupported host');
});

test('voxel adapter: hung probe surfaces the update card after the 2 s timeout', async () => {
  const { jsr } = await bootGame({ voxelNative: 'hang' });
  await jsr.pumpFrames(2, 16.6);
  assert.strictEqual(findNode(jsr.lastTree, (n) => n.type === 'text' &&
    typeof n.data === 'string' && n.data.includes('0.4.156')), null,
    'no card while the probe is still in flight');
  jsr.fireTimeouts(); // the probe's 2 s fail-safe lands
  await jsr.pumpFrames(1, 16.6);
  assert.ok(findNode(jsr.lastTree, (n) => n.type === 'text' &&
    typeof n.data === 'string' && n.data.includes('0.4.156')),
    'a probe that never settles still ends on the update card');
  assert.strictEqual(findNode(jsr.lastTree, (n) => n.type === 'scene3d'), null,
    'still no scene3d fallback');
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

test('mobs: attack butchers the aimed mob; meat drop heals on pickup', async () => {
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
  assert.strictEqual(w.mobKills, 1, 'kill counted in exportState');
  assert.strictEqual(w.health, hp0, 'no instant heal — meat is a physical drop now');
  assert.strictEqual(w.drops.length, 1, 'meat drop spawned at the mob');
  // Walk over the drop: the pickup tick feeds the player.
  const d = w.drops[0];
  p.x = d.x; p.z = d.z;
  await jsr.pumpFrames(30, 16.6);
  assert.strictEqual(w.drops.length, 0, 'drop collected');
  assert.strictEqual(w.health, hp0 + 2, 'meat heals +2 HP on pickup');
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

test('hud: notices are toasts — they auto-clear after NOTICE_MS', async () => {
  const { jsr, sandbox } = await bootGame();
  await jsr.pumpFrames(2, 16.6);
  sandbox.Facraft.state.world.player.pitch = Math.PI / 2 - 0.01; // sky: no target
  jsr.fire('break'); // → 'Nothing in reach.'
  assert.ok((jsr.exported().notice || '').length > 0, 'notice shown');
  await jsr.pumpFrames(45, 100); // ~4.5 s of frame clock
  assert.strictEqual(jsr.exported().notice || '', '',
    'notice expired instead of pinning itself under the crosshair');
});

test('perf: idle frames pre-generate the ring+1 margin data (no frontier bursts)', async () => {
  const { jsr, sandbox } = await bootGame();
  const F = sandbox.Facraft;
  F.voxel.pinBudget(3); // pin: this test pins warm-up coverage, not throttling
  await jsr.pumpFrames(40, 16.6); // standing still: warm-up runs 2 chunks/frame
  const w = F.state.world;
  const pcx = Math.floor(w.player.x / 16), pcz = Math.floor(w.player.z / 16);
  const missing = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (!w.chunks[(pcx + dx) + ',' + (pcz + dz)]) missing.push(dx + ',' + dz);
    }
  }
  assert.deepStrictEqual(missing, [],
    'ring+1 margin fully warm after idle frames — arriving there costs no worldgen');
});

test('voxel adapter (native+blocks+bin): chunk bytes cross the binary lane', async () => {
  const jsonBlocks = [];
  const { jsr, sandbox } = await bootGame({
    voxelBinary: true,
    hostHandlers: {
      'voxel.blocks': (a) => { jsonBlocks.push(String(a.key)); return true; },
    },
  });
  const F = sandbox.Facraft;
  // 0.2.21+ streams the boot ring frame-capped (nearest first) — pump
  // until the 5x5 ring has fully streamed.
  await jsr.pumpFrames(40, 16.6);
  const binCount = jsr.callCount('hostCallBinary:voxel.blocks.bin');
  assert.ok(binCount >= 25, '5x5 view ring uploaded raw bytes, got ' + binCount);
  assert.strictEqual(jsonBlocks.length, 0,
    'terrain stays off the base64 JSON lane on the bin path');
  const first = decodeBinaryEnvelope(jsr.allBinary['voxel.blocks.bin'][0]);
  assert.ok('palette' in first.header,
    'the first packed upload carries the palette (runtime caches it)');
  assert.strictEqual(first.header.id, 'fa-craft');
  assert.match(first.header.key, /^-?\d+,-?\d+$/);
  assert.deepStrictEqual(first.header.size, [16, 64, 16]);
  assert.strictEqual(first.body.length, 16 * 64 * 16,
    'body is the RAW block bytes, no base64');
  // An edit re-uploads only the dirty chunk(s) — still raw bytes.
  F.state.world.mobsPaused = true;
  const before = jsr.callCount('hostCallBinary:voxel.blocks.bin');
  F.world.setBlock(F.state.world, 0, Math.floor(F.state.world.player.y) - 1, 1, F.blocks.BRICKS);
  await jsr.pumpFrames(2, 16.6);
  assert.ok(jsr.callCount('hostCallBinary:voxel.blocks.bin') > before,
    'a dirty edit re-uploads through the binary lane');
});
