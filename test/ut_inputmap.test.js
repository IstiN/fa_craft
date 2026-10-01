'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/inputmap.js'];

test('inputmap: every movement/action verb has at least one key binding', async () => {
  const { F } = await loadNamespace(MODS);
  const required = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint', 'fly', 'craft', 'debug', 'break', 'place'];
  for (let slot = 1; slot <= 8; slot++) required.push('hotbar' + slot);
  const mapped = new Set();
  for (const k of Object.keys(F.inputmap.KEY_ACTIONS)) mapped.add(F.inputmap.KEY_ACTIONS[k]);
  for (const a of required) assert.ok(mapped.has(a), 'key binding for ' + a);
});

test('inputmap: held verbs are classified; taps are not held', async () => {
  const { F } = await loadNamespace(MODS);
  assert.ok(F.inputmap.isHeld('forward'), 'forward is held');
  assert.ok(F.inputmap.isHeld('jump'), 'jump is held');
  assert.ok(!F.inputmap.isHeld('fly'), 'fly is a tap');
  assert.ok(!F.inputmap.isHeld('hotbar3'), 'hotbar is a tap');
});

test('inputmap: key events map down/up symmetrically, repeats suppressed for taps', async () => {
  const { F } = await loadNamespace(MODS);
  const held = {};
  // movement: repeat events keep the held state
  let r = F.inputmap.applyKey(held, { key: 'w', down: true, repeat: false });
  assert.strictEqual(r.action, 'forward');
  F.inputmap.applyKey(held, { key: 'w', down: true, repeat: true });
  F.inputmap.applyKey(held, { key: 'w', down: false, repeat: false });
  assert.strictEqual(held.forward, false, 'released');
  // taps: repeat must not retrigger
  let taps = 0;
  const r1 = F.inputmap.applyKey({}, { key: 'f', down: true, repeat: false });
  assert.strictEqual(r1.action, 'fly');
  const r2 = F.inputmap.applyKey({}, { key: 'f', down: true, repeat: true });
  assert.strictEqual(r2.action, null, 'repeat suppressed for tap actions');
});

test('inputmap: digits map to hotbar slots', async () => {
  const { F } = await loadNamespace(MODS);
  for (let i = 1; i <= 8; i++) {
    const r = F.inputmap.applyKey({}, { key: 'digit' + i, down: true, repeat: false });
    assert.strictEqual(r.action, 'hotbar' + i);
  }
});

test('inputmap: touch look — pan deltas become yaw/pitch with sensitivity', async () => {
  const { F } = await loadNamespace(MODS);
  const look = F.inputmap.panToLook(120, -40, F.inputmap.LOOK_SENS);
  assert.ok(look.dyaw < 0 || look.dyaw > 0, 'yaw responds to dx');
  assert.strictEqual(look.dyaw, -120 * F.inputmap.LOOK_SENS, 'drag right → look right (negative yaw delta convention)');
  assert.strictEqual(look.dpitch, 40 * F.inputmap.LOOK_SENS, 'drag up (negative dy) → look up');
  assert.ok(Math.abs(F.inputmap.panToLook(0, 0, 1).dyaw) === 0);
});

test('inputmap: joystick vector becomes move axes clamped to unit circle', async () => {
  const { F } = await loadNamespace(MODS);
  const m = F.inputmap.joystickMove(50, -50, 60);
  assert.ok(m.x !== 0 && m.z !== 0, 'diagonal input drives both axes');
  const len = Math.hypot(m.x, m.z);
  assert.ok(len <= 1.001, 'clamped to unit circle: ' + len);
  const far = F.inputmap.joystickMove(500, 0, 60);
  assert.ok(Math.hypot(far.x, far.z) <= 1.001, 'overshoot clamps');
});

test('inputmap: pointer-lock deltas reuse the same look mapping (AC7 surface)', async () => {
  const { F } = await loadNamespace(MODS);
  const drag = F.inputmap.panToLook(30, 0, 1);
  const lock = F.inputmap.pointerDeltaToLook(30, 0, 1);
  assert.strictEqual(drag.dyaw, lock.dyaw, 'same verb, same mapping regardless of surface');
});
