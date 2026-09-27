// Per-chunk face-culling mesher. Emits plain arrays (JSON-friendly bridge
// payloads): chunk-local positions, per-vertex colors, quad indices.
// Only dirty chunks rebuild (buffer reuse, IT gate).
var Facraft = Facraft || {};
Facraft.mesh = (function() {
  var W = function() { return Facraft.world; };
  var WG = function() { return Facraft.worldgen; };
  var B = function() { return Facraft.blocks; };

  // face table: dir → 4 corner offsets (CCW from outside)
  var FACES = [
    { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];

  function block(w, lx, y, lz, cx, cz) {
    if (y < 0 || y >= WG().CHUNK_Y) return B().AIR;
    var dx = 0, dz = 0, x = lx, z = lz;
    if (lx < 0) { dx = -1; x = lx + 16; } else if (lx > 15) { dx = 1; x = lx - 16; }
    if (lz < 0) { dz = -1; z = lz + 16; } else if (lz > 15) { dz = 1; z = lz - 16; }
    var k = W().key(cx + dx, cz + dz);
    var c = w.chunks[k];
    if (!c) { c = WG().chunk(w.seed, cx + dx, cz + dz); w.chunks[k] = c; }
    return c[WG().index(x, y, z)];
  }

  function buildChunk(w, cx, cz) {
    var positions = [], colors = [], indices = [];
    var col = [0, 0, 0];
    for (var lx = 0; lx < 16; lx++) {
      for (var lz = 0; lz < 16; lz++) {
        for (var y = 0; y < WG().CHUNK_Y; y++) {
          var b = block(w, lx, y, lz, cx, cz);
          if (!B().isSolid(b)) continue;
          col = B().color(b);
          for (var f = 0; f < 6; f++) {
            var face = FACES[f];
            var nb = block(w, lx + face.n[0], y + face.n[1], lz + face.n[2], cx, cz);
            if (B().isSolid(nb)) continue; // culled
            var base = positions.length / 3;
            for (var v = 0; v < 4; v++) {
              positions.push(lx + face.c[v][0], y + face.c[v][1], lz + face.c[v][2]);
              colors.push(col[0], col[1], col[2]);
            }
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }
    return { positions: positions, colors: colors, indices: indices, origin: [cx * 16, 0, cz * 16] };
  }

  // Rebuild only dirty chunks; untouched meshes keep their buffer objects.
  function rebuildDirty(w) {
    var built = [];
    w.dirty.forEach(function(k) {
      var parts = k.split(',');
      w.meshes.set(k, buildChunk(w, parseInt(parts[0], 10), parseInt(parts[1], 10)));
      built.push(k);
    });
    w.dirty.clear();
    return built;
  }

  return { buildChunk: buildChunk, rebuildDirty: rebuildDirty };
})();
