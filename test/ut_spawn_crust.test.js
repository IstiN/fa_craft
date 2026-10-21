'use strict';
// The spawn ring must keep a solid surface crust: cave carving may not
// eat the top blocks inside d<=40 (surface holes read as void at first
// sight and mobs by the hole look like they float).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = ['noise.js', 'blocks.js', 'worldgen.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'game', f), 'utf8'))
  .join('\n') + '\n return Facraft;';
const F = new Function(src)();
const wg = F.worldgen;

for (const seed of [111, 4242, 90210, 777, 1]) {
  test(`seed ${seed}: spawn ring surface crust intact`, () => {
    for (let wx = -40; wx <= 40; wx += 3) {
      for (let wz = -40; wz <= 40; wz += 3) {
        const d = Math.max(Math.abs(wx), Math.abs(wz));
        if (d > 40) continue;
        const h = wg.height(seed, wx, wz);
        const c = wg.chunk(seed, Math.floor(wx / 16), Math.floor(wz / 16));
        const lx = ((wx % 16) + 16) % 16, lz = ((wz % 16) + 16) % 16;
        // The surface cell and 4 blocks below it must be solid.
        for (let y = h; y > h - 5 && y > 0; y--) {
          assert.ok(
            c[wg.index(lx, y, lz)] !== F.blocks.AIR,
            `seed ${seed} (${wx},${wz}) y=${y} carved inside the ring`
          );
        }
      }
    }
  });
}
