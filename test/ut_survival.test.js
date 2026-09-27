'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadNamespace } = require('./harness.js');

const MODS = ['game/blocks.js', 'game/survival.js'];

function fresh() {
  return { health: 20, dead: false, deaths: 0 };
}

test('survival: hard landing deals fall damage scaled by impact speed', async () => {
  const { F } = await loadNamespace(MODS);
  const s = fresh();
  const r1 = F.survival.landing(s, 10); // gentle
  assert.strictEqual(r1.damage, 0, 'under threshold: no damage');
  const r2 = F.survival.landing(s, 16); // hard
  assert.ok(r2.damage > 0, 'hard landing hurts');
  assert.ok(s.health < 20);
});

test('survival: fatal impact kills; health never goes negative', async () => {
  const { F } = await loadNamespace(MODS);
  const s = fresh();
  F.survival.landing(s, 100);
  assert.strictEqual(s.dead, true);
  assert.strictEqual(s.health, 0);
});

test('survival: void below the world drains health per tick (environment damage)', async () => {
  const { F } = await loadNamespace(MODS);
  const s = fresh();
  const d1 = F.survival.voidTick(s, -20, 1).damage;
  const d0 = F.survival.voidTick(s, 30, 1).damage;
  assert.ok(d1 > 0, 'void hurts');
  assert.strictEqual(d0, 0, 'safe altitude does not');
  const h0 = s.health;
  F.survival.voidTick(s, -20, 1);
  assert.ok(s.health < h0, 'repeated ticks stack');
});

test('survival: respawn restores health, keeps inventory (E7)', async () => {
  const { F } = await loadNamespace(MODS);
  const s = fresh();
  s.inventory = {};
  s.inventory[F.blocks.LOG] = 7;
  F.survival.damage(s, 'fall', 25);
  assert.strictEqual(s.dead, true);
  F.survival.respawn(s, { x: 0.5, y: 40, z: 0.5 });
  assert.strictEqual(s.dead, false);
  assert.strictEqual(s.health, 20);
  assert.strictEqual(s.inventory[F.blocks.LOG], 7, 'no vanished blocks on respawn');
  assert.strictEqual(s.deaths, 1);
});

test('survival: crafting inventory survives death mid-craft (E7 consistency)', async () => {
  const { F } = await loadNamespace(MODS);
  const s = fresh();
  s.inventory = {};
  s.inventory[F.blocks.LOG] = 4;
  F.survival.damage(s, 'void', 30); // dies mid-craft
  F.survival.respawn(s, { x: 0.5, y: 40, z: 0.5 });
  assert.strictEqual(s.inventory[F.blocks.LOG], 4, 'no duped or vanished blocks');
});

test('survival: damage on dead player is a no-op (idempotent death)', async () => {
  const { F } = await loadNamespace(MODS);
  const s = fresh();
  F.survival.damage(s, 'fall', 25);
  const h = s.health;
  const r = F.survival.damage(s, 'fall', 5);
  assert.strictEqual(r.damage, 0, 'dead players take no further damage');
  assert.strictEqual(s.health, h);
});
