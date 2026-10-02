// Fa Craft — bootstrap and game loop. Every gameplay-facing line lives here
// or in the game/* modules; the runtime only ever sees generic bridge calls
// (I1) and every mutation enters the world event log (I3).
import './blocks.js';
import './rng.js';
import './noise.js';
import './worldgen.js';
import './eventlog.js';
import './world.js';
import './physics.js';
import './raycast.js';
import './mesh.js';
import './craft.js';
import './survival.js';
import './daynight.js';
import './inputmap.js';
import './hud.js';
import './mobs.js';
import './voxel.js';

(function() {
  var B = Facraft.blocks, W = Facraft.world, P = Facraft.physics,
    R = Facraft.raycast, S = Facraft.survival, D = Facraft.daynight,
    IM = Facraft.inputmap, HUD = Facraft.hud;

  var KEY = 'fa-craft:world:v1';
  var SAVE_MS = 5000;
  var REACH = 6;
  var LOOK_SENS = IM.LOOK_SENS;
  var PITCH_MAX = 1.55;

  var state = {
    world: null,
    selected: 1,
    craftOpen: false,
    debug: false,
    notice: '',
    hint: true, // drag-to-look hint until pointer lock engages (E6 fallback)
    pointerLocked: false,
    fps: 0,
  };
  var held = {};
  var joy = { active: false, x: 0, z: 0 };
  var lastFrame = 0;
  var bootReady = false;
  var lastHudSig = '';
  var lastCamKey = '';

  // Lightweight profiler: windowed frame-cost counters, exported via
  // exportState and dumped to the console every 300 frames. This is how a
  // host (or the CLI) sees WHERE frames are slow (hud render vs mesh work)
  // and how much geometry crossed the bridge.
  var prof = {
    frames: 0, hudMs: 0, meshMs: 0, camCalls: 0,
    uploads: 0, meshBytes: 0,
  };
  Facraft.prof = prof;

  function hotbarBlocks() { return HUD.hotbarBlocks(); }
  Facraft.hotbarSlotOf = function(blockId) {
    var hb = hotbarBlocks();
    for (var i = 0; i < hb.length; i++) if (hb[i] === blockId) return i + 1;
    return 1;
  };

  function eye() {
    var p = state.world.player;
    return { x: p.x, y: p.y + P.EYE_H, z: p.z };
  }

  function pickTarget() {
    var p = state.world.player;
    var e = eye();
    var d = P.dirOf(p.yaw, p.pitch);
    return R.pick(state.world, e.x, e.y, e.z, d.x, d.y, d.z, REACH);
  }

  function setNotice(msg) {
    state.notice = msg || '';
    exportNow();
  }

  function exportNow() {
    if (!state.world) return;
    var p = state.world.player;
    jsr.exportState({
      mode: state.world.mode,
      health: state.world.health,
      dead: state.world.dead,
      selected: state.selected,
      pos: { x: p.x, y: p.y, z: p.z },
      dayTime: state.world.dayTime,
      edits: state.world.logOps.length,
      inventory: state.world.inventory,
      notice: state.notice,
      hint: state.hint,
      flying: p.flying === true,
      mobs: (state.world.mobs || []).length,
      mobKills: state.world.mobKills || 0,
      craftOpen: state.craftOpen,
      debug: state.debug,
      fps: Math.round(state.fps),
      prof: {
        native: Facraft.voxel.isNative(),
        hudMs: Math.round((prof.hudMs / Math.max(1, prof.frames)) * 10) / 10,
        meshMs: Math.round((prof.meshMs / Math.max(1, prof.frames)) * 10) / 10,
        uploads: prof.uploads,
        meshKB: Math.round(prof.meshBytes / 1024),
      },
    });
  }

  // Signature of everything the HUD tree can express. Native mode renders
  // a CONSTANT viewport node ({type:'voxel'}) — when nothing HUD-visible
  // changed, re-sending the tree is pure bridge cost, so render() skips.
  // (Legacy scene3d mode is excluded: its camera lives INSIDE the tree and
  // must follow the eye every frame.)
  function hudSig() {
    var w = state.world, t = state.target, th = jsr.theme;
    return Math.round(state.fps) + '|' + w.health + '|' + w.dead + '|' +
      state.selected + '|' + state.notice + '|' + state.craftOpen + '|' +
      state.debug + '|' + state.hint + '|' + Math.floor(w.dayTime) + '|' +
      (t && t.hit ? t.x + ',' + t.y + ',' + t.z : '-') + '|' +
      JSON.stringify(w.inventory) + '|' + th.isDark + '|' + th.bg + '|' + th.accent;
  }

  function render() {
    if (!state.world) return;
    state.target = pickTarget(); // fresh per render: event-path frames highlight too
    var sig = hudSig();
    if (sig === lastHudSig && Facraft.voxel.isNative()) return;
    lastHudSig = sig;
    jsr.render(HUD.build(state, jsr.theme));
  }

  // --- events -------------------------------------------------------------

  function onHotbar(payload) {
    var hbLen = hotbarBlocks().length;
    if (payload && payload.slot !== undefined && payload.slot !== null) {
      if (typeof payload.slot === 'number' && payload.slot >= 1 && payload.slot <= hbLen) {
        state.selected = payload.slot;
      } // explicit but invalid slot: ignored
    } else {
      state.selected = (state.selected % hbLen) + 1; // bare tap cycles
    }
  }

  function onBreak() {
    // Livestock first: a mob in front of the eye (closer than the aimed
    // block or simply point-blank) takes the hit — butchering drops meat.
    var p0 = state.world.player;
    var e0 = eye();
    var d0 = P.dirOf(p0.yaw, p0.pitch);
    var mh = Facraft.mobs.raycast(
      state.world, e0.x, e0.y, e0.z, d0.x, d0.y, d0.z, 3.5);
    if (mh) {
      var meat = Facraft.mobs.kill(state.world, mh.index);
      state.world.mobKills = (state.world.mobKills || 0) + 1;
      state.world.health = Math.min(20, state.world.health + 2);
      setNotice(meat === 'pig' ? 'Pork chop! +2 HP' : 'Chicken! +2 HP');
      return;
    }
    var tb = pickTarget();
    if (!tb.hit) { setNotice('Nothing in reach.'); return; }
    try {
      W.apply(state.world, { t: 'set', x: tb.x, y: tb.y, z: tb.z, b: B.AIR });
    } catch (e) { setNotice(e.message); }
  }

  function onPlace() {
    var blockId = hotbarBlocks()[state.selected - 1];
    if (state.world.mode === 'survival' && (state.world.inventory[blockId] || 0) < 1) {
      setNotice('Nothing to place — break some ' + B.name(blockId) + ' first.');
      return;
    }
    var tp = pickTarget();
    if (!tp.hit) { setNotice('Nothing in reach.'); return; }
    try {
      W.apply(state.world, { t: 'set', x: tp.px, y: tp.py, z: tp.pz, b: blockId });
    } catch (e2) { setNotice(e2.message); }
  }

  function onCraft() { state.craftOpen = !state.craftOpen; }

  function onCraftRecipe(payload) {
    var id = payload && payload.id;
    if (!id) id = Facraft.craft.recipes[0].id; // tolerate missing payload (CLI)
    try {
      W.apply(state.world, { t: 'craft', r: id, n: 1 });
      setNotice('Crafted ' + id + '.');
    } catch (e3) { setNotice(e3.message); }
  }

  function onFly() {
    if (state.world.mode !== 'creative') { setNotice('Fly is creative-only.'); return; }
    state.world.player.flying = !state.world.player.flying;
  }

  function onMode() {
    try {
      W.apply(state.world, { t: 'mode', m: state.world.mode === 'survival' ? 'creative' : 'survival' });
    } catch (e4) { setNotice(e4.message); }
  }

  function onRespawn() {
    if (state.world.dead) {
      try { W.apply(state.world, { t: 'respawn' }); } catch (e5) { setNotice(e5.message); }
    }
  }

  function onLook(payload) {
    var dx = payload && typeof payload.dx === 'number' ? payload.dx : 0;
    var dy = payload && typeof payload.dy === 'number' ? payload.dy : 0;
    var look = IM.panToLook(dx, dy, LOOK_SENS);
    state.world.player.yaw += look.dyaw;
    state.world.player.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, state.world.player.pitch + look.dpitch));
  }

  // Trackpad two-finger swipe / wheel: scroll deltas follow CONTENT-scroll
  // semantics (opposite sign to drag deltas, and the OS natural-scrolling
  // setting applies), so invert before feeding the drag-look mapping.
  function onScrollLook(payload) {
    var dx = payload && typeof payload.dx === 'number' ? payload.dx : 0;
    var dy = payload && typeof payload.dy === 'number' ? payload.dy : 0;
    onLook({ dx: -dx, dy: -dy });
  }

  function onJoyMove(payload) {
    joy.active = true;
    // The pad is 96x96: pan localPosition (x, y) minus the pad center is
    // the stick offset. (dx/dy are PER-EVENT deltas — using them as the
    // stick vector scaled movement to ~4% and read as "move is broken".)
    var px = payload && typeof payload.x === 'number' ? payload.x : 48;
    var py = payload && typeof payload.y === 'number' ? payload.y : 48;
    var m = IM.joystickMove(px - 48, py - 48);
    joy.x = m.x; joy.z = m.z;
  }

  function onJoyEnd() { joy.active = false; joy.x = 0; joy.z = 0; }

  // Touch jump pad: hold-to-hop — physics reads input.jump every step.
  function onJumpDown() { held.jumpPad = true; }
  function onJumpUp() { held.jumpPad = false; }

  function onPointerLock(payload) {
    // reserved surface for the upstream pointer-lock input PR (AC7):
    // when the host engages the lock the drag hint goes away; on loss it
    // comes back — the drag-to-look fallback stays available either way.
    state.pointerLocked = payload && payload.down === true;
    state.hint = !state.pointerLocked;
  }

  var ACTIONS = {
    hotbar: onHotbar, break: onBreak, place: onPlace,
    craft: onCraft, closeCraft: function() { state.craftOpen = false; },
    craftRecipe: onCraftRecipe, fly: onFly, mode: onMode,
    respawn: onRespawn, debug: function() { state.debug = !state.debug; },
    look: onLook, scrollLook: onScrollLook, joyMove: onJoyMove, joyEnd: onJoyEnd,
    jumpDown: onJumpDown, jumpUp: onJumpUp,
    pointerLock: onPointerLock,
  };

  var RESERVED = { 'state.sync': 1, 'back': 1, 'llm.delta': 1, 'tile.refresh': 1 };

  function handleEvent(actionId, payload) {
    if (RESERVED[actionId]) return; // reserved host traffic — never UI actions
    if (!bootReady) return;
    var handler = ACTIONS[actionId];
    if (!handler) return; // unknown actions are no-ops
    handler(payload);
    render();
    exportNow();
  }

  function handleKey(ev) {
    if (!bootReady) return;
    var r = IM.applyKey(held, ev);
    if (r.action && !r.held) handleEvent(r.action);
  }

  // --- loop ---------------------------------------------------------------

  function tick(tMs) {
    if (bootReady && state.world) {
      var dt = lastFrame ? Math.min((tMs - lastFrame) / 1000, P.DT_MAX) : 0;
      if (dt < 0) dt = 0;
      lastFrame = tMs;
      if (dt > 0) state.fps = state.fps ? state.fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;

      var w = state.world;
      w.dayTime = D.advance(w.dayTime, dt);

      var input = {
        forward: held.forward === true, back: held.back === true,
        left: held.left === true, right: held.right === true,
        jump: held.jump === true || held.jumpPad === true,
        sneak: held.sneak === true,
        sprint: held.sprint === true,
        moveS: joy.active ? joy.x : 0, moveF: joy.active ? joy.z : 0,
      };
      var res = P.step(w.player, input, w, dt, w.mode);
      if (res.landed > 0) {
        var dmg = S.landing(w, res.landed).damage;
        if (dmg > 0) {
          try { W.apply(w, { t: 'damage', cause: 'fall', n: dmg }); } catch (e) { /* never blocks the loop */ }
        }
      }
      var vdmg = S.voidTick(w, w.player.y, dt);
      if (vdmg.damage > 0) {
        try { W.apply(w, { t: 'damage', cause: 'void', n: vdmg.damage }); } catch (e2) { /* ditto */ }
      }
      if (w.dead && w.player.flying) w.player.flying = false;

      var pcx = Math.floor(w.player.x / 16), pcz = Math.floor(w.player.z / 16);
      W.ensureArea(w, pcx, pcz, W.LOAD_RADIUS);

      var h0 = Date.now();
      render();
      prof.hudMs += Date.now() - h0;

      // Native voxel path (I4): dirty/new chunks + aim highlight + camera.
      // Runs after render() so the highlight tracks the fresh raycast target.
      var m0 = Date.now();
      Facraft.voxel.sync(w, w.player, prof);
      Facraft.voxel.highlight(w, state.target);
      // Camera pushes wake a full scene repaint — push only when the eye
      // state actually moved (quantized to ~1/64 block / ~1/256 rad), so
      // standing still costs ZERO paints while look stays per-event
      // responsive (a time gate would add visible drag latency).
      var cp = w.player;
      var camKey = Math.round(cp.x * 64) + '|' + Math.round(cp.y * 64) + '|' +
        Math.round(cp.z * 64) + '|' + Math.round(cp.yaw * 256) + '|' +
        Math.round(cp.pitch * 256) + '|' + Math.floor(w.dayTime * 2);
      if (camKey !== lastCamKey) {
        lastCamKey = camKey;
        Facraft.voxel.camera(w, w.player, D.sky(w.dayTime));
      }
      // Passive mobs wander after the camera push — their chunk uploads
      // ride the same frame.
      Facraft.mobs.tick(w, dt);
      prof.meshMs += Date.now() - m0;

      // exportState every frame: the payload is small (scalars + inventory
      // map) and CLI snapshots must stay live — the bridge cost that killed
      // the old path was the megabyte mesh JSON, not small calls.
      exportNow();

      prof.frames++;
      if (prof.frames % 300 === 0) {
        console.log('[facraft] fps=' + Math.round(state.fps) +
          ' hud=' + (prof.hudMs / prof.frames).toFixed(1) + 'ms' +
          ' mesh=' + (prof.meshMs / prof.frames).toFixed(1) + 'ms' +
          ' uploads=' + prof.uploads + ' meshKB=' + Math.round(prof.meshBytes / 1024) +
          ' native=' + Facraft.voxel.isNative());
        prof.frames = 0; prof.hudMs = 0; prof.meshMs = 0; prof.camCalls = 0;
      }
    }
    requestAnimationFrame(tick);
  }

  // --- persistence ----------------------------------------------------------

  function save() {
    if (!bootReady || !state.world) return;
    var p = state.world.player;
    var payload = {
      v: 1,
      seed: state.world.seed,
      dayTime: state.world.dayTime,
      log: state.world.logOps,
      player: { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flying: p.flying === true },
    };
    jsr.storage.set(KEY, JSON.stringify(payload)).then(function() {
      if (state.notice && state.notice.indexOf('Save failed') === 0) setNotice('');
    }, function() {
      setNotice('Save failed — progress will be lost if the game closes.'); // E2
    });
  }

  function validEnvelope(data) {
    if (!data || data.v !== 1 || typeof data.seed !== 'number' ||
      !isFinite(data.seed) || Math.floor(data.seed) !== data.seed ||
      !Array.isArray(data.log) || !data.log) throw new Error('bad save');
  }

  function validPlayer(p) {
    if (p === null || p === undefined) return;
    if (typeof p !== 'object' || typeof p.x !== 'number' || typeof p.y !== 'number' ||
      typeof p.z !== 'number' || typeof p.yaw !== 'number' || typeof p.pitch !== 'number') {
      throw new Error('bad player');
    }
  }

  function validPayload(raw) {
    var data = JSON.parse(raw); // throws on garbage (E5)
    validEnvelope(data);
    validPlayer(data.player);
    if (typeof data.dayTime !== 'number' || !isFinite(data.dayTime) || data.dayTime < 0) {
      throw new Error('bad clock');
    }
    return data;
  }

  function hydrate(raw) {
    var data = null;
    if (raw !== null && raw !== undefined) {
      try { data = validPayload(raw); } catch (e) { data = null; }
    }
    if (data) {
      try {
        state.world = W.fromLog(data.seed, data.log);
        if (data.player) {
          var p = state.world.player, sp = data.player;
          p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw; p.pitch = sp.pitch;
          p.flying = sp.flying === true && state.world.mode === 'creative';
        }
        state.world.dayTime = data.dayTime;
      } catch (e2) { newWorld(true); } // hostile ops → quarantined fresh world (E5)
    } else if (raw !== null && raw !== undefined) {
      newWorld(true);
    } else {
      newWorld(false);
    }
    start();
  }

  function newWorld(corrupt) {
    state.world = W.create((Date.now() & 0x7fffffff) || 42);
    if (corrupt) setNotice('Loaded a fresh world — the old save was corrupted and quarantined.');
  }

  function start() {
    bootReady = true;
    render();
    exportNow();
    requestAnimationFrame(tick);
  }

  // --- boot ---------------------------------------------------------------

  Facraft.state = state; // observable for tests and the CLI

  jsr.onEvent(handleEvent); // registered before first render
  jsr.onKey(handleKey);
  jsr.setTitle('⛏ Fa Craft');
  Facraft.voxel.probe(); // I4: async capability probe — native path flips on
  setInterval(save, SAVE_MS);
  jsr.storage.get(KEY).then(hydrate, function() { newWorld(true); start(); });
})();
