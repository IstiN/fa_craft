// Hash-based value noise (2D/3D) with fBm. Pure integer hashing → identical
// output on every engine; no Math.random anywhere.
var Facraft = Facraft || {};
Facraft.noise = (function() {
  function hash2(seed, x, y) {
    var h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function hash3(seed, x, y, z) {
    var h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function value2(seed, x, y) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = smooth(x - ix), fy = smooth(y - iy);
    return lerp(
      lerp(hash2(seed, ix, iy), hash2(seed, ix + 1, iy), fx),
      lerp(hash2(seed, ix, iy + 1), hash2(seed, ix + 1, iy + 1), fx), fy) * 2 - 1;
  }

  function value3(seed, x, y, z) {
    var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    var fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
    var c00 = lerp(hash3(seed, ix, iy, iz), hash3(seed, ix + 1, iy, iz), fx);
    var c10 = lerp(hash3(seed, ix, iy + 1, iz), hash3(seed, ix + 1, iy + 1, iz), fx);
    var c01 = lerp(hash3(seed, ix, iy, iz + 1), hash3(seed, ix + 1, iy, iz + 1), fx);
    var c11 = lerp(hash3(seed, ix, iy + 1, iz + 1), hash3(seed, ix + 1, iy + 1, iz + 1), fx);
    return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz) * 2 - 1;
  }

  function fbm2(seed, x, y, octaves) {
    var sum = 0, amp = 1, freq = 1, norm = 0;
    for (var o = 0; o < octaves; o++) {
      sum += value2(seed + o * 1013, x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  function fbm3(seed, x, y, z, octaves) {
    var sum = 0, amp = 1, freq = 1, norm = 0;
    for (var o = 0; o < octaves; o++) {
      sum += value3(seed + o * 1013, x * freq, y * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  return { value2: value2, value3: value3, fbm2: fbm2, fbm3: fbm3, hash2: hash2 };
})();
