// Voxel host adapter (I1: the only file that knows the runtime 3D
// capability). World geometry reaches the production renderer through the
// scene3d node's software `meshes` path (pure Dart CustomPaint — no host
// engine needed): chunk meshes are converted to world-space per-color face
// batches, cached by (chunk set, edit count, eye height, target cell) and
// reused by array identity across frames so the renderer's per-list parse
// cache hits. The GPU voxel/mesh node upstream (I4) replaces this adapter
// wholesale when it ships.
var Facraft = Facraft || {};
Facraft.voxel = (function() {
  var M = function() { return Facraft.mesh; };
  var B = function() { return Facraft.blocks; };
  var WG = function() { return Facraft.worldgen; };

  var VIEW_RADIUS = 2;  // chunk radius meshed for the software rasterizer
  var Y_BELOW = 20;     // vertical band around the eye that gets meshed
  var Y_ABOVE = 14;
  var FOV = 72;
  var LIGHT = [-0.45, -0.85, -0.3]; // flat Lambert sun direction

  var cache = { key: null, meshes: null };

  function reset() { cache.key = null; cache.meshes = null; }

  function hex(r, g, b) {
    function c2(v) {
      var c = Math.max(0, Math.min(255, Math.round(v * 255)));
      return (c < 16 ? '0' : '') + c.toString(16);
    }
    return '#' + c2(r) + c2(g) + c2(b);
  }

  function hexRGB(c) { return hex(c[0], c[1], c[2]); }

  // ---- illustrated faces ----
  // The 0.4.126 scene3d mesh node is colors-only (vertices + faces + flat
  // albedo), so block "textures" are built geometrically: near-field faces
  // subdivide into a MOSAIC x MOSAIC grid whose cells pick from a
  // per-block-type palette through a position-seeded hash — deterministic
  // across frames and runs, varied per block. Equal-color row runs merge
  // into one quad, so structured faces (planks, bricks, bark) stay cheap.
  var MOSAIC = 4;
  var DETAIL_R2 = 30 * 30; // chunk-center distance²: nearer chunks mosaic, the far field stays one flat quad per face (keeps rebuilds tied to the existing chunk-pair cache key)
  var SHADES = [0.86, 0.95, 1.04, 1.12];

  function h32(a, b, c, d) {
    var x = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791) ^ ((d | 0) * 2654435761);
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return (x ^ (x >>> 16)) >>> 0;
  }

  function mul(c, m) { return [c[0] * m, c[1] * m, c[2] * m]; }

  function soil(d, r) {
    if (r < 16) return mul(d, 0.72); // clod shadow
    return mul(d, r < 30 ? 1.15 : SHADES[r % 4]);
  }

  // One mosaic cell's albedo. cls: 0 bottom / 1 side / 2 top; v rows run
  // bottom→top on side faces (mesh.js corner tables), so j = MOSAIC-1 is the
  // face's top edge.
  function cellColor(id, cls, wx, wy, wz, i, j) {
    var Bk = B();
    var h = h32(wx, wy, wz, (cls << 6) | (i * MOSAIC + j));
    var r = h % 100;
    switch (id) {
      case Bk.GRASS: {
        var g = Bk.color(Bk.GRASS);
        var turf = (cls === 2) || (cls === 1 && (j >= MOSAIC - 1 ||
          (j === MOSAIC - 2 && (h >>> 7) % 100 < 45))); // turf overhang fringe
        if (turf) {
          if (r < 18) return [g[0] * 1.25, g[1] * 1.12, g[2] * 0.7]; // dry blade
          return mul(g, SHADES[r % 4]);
        }
        return soil(Bk.color(Bk.DIRT), r);
      }
      case Bk.DIRT: return soil(Bk.color(id), r);
      case Bk.STONE: {
        var s = Bk.color(id);
        if (r < 14) return mul(s, 0.7); // crack
        return mul(s, r < 30 ? 1.12 : SHADES[r % 4]);
      }
      case Bk.LOG: {
        var l = Bk.color(id);
        if (cls === 1) { // bark: vertical striping + grain jitter
          var stripe = [0.8, 1.02, 0.88, 1.08][i];
          return mul(l, r < 12 ? stripe * 0.9 : stripe);
        }
        var ring = Math.floor(Math.max(Math.abs(i - 1.5), Math.abs(j - 1.5))); // end-grain rings
        return mul(l, (ring % 2 ? 0.78 : 1.04) * (r < 12 ? 0.92 : 1));
      }
      case Bk.LEAVES: {
        var lv = Bk.color(id);
        if (r < 18) return mul(lv, 0.6); // depth hole
        return mul(lv, r < 40 ? 1.18 : SHADES[r % 4]);
      }
      case Bk.SAND: {
        var sa = Bk.color(id);
        return mul(sa, r < 16 ? 0.85 : r < 30 ? 1.1 : SHADES[r % 4]);
      }
      case Bk.PLANKS: {
        var p = Bk.color(id);
        if (j % 2 === 1) return mul(p, 0.72); // board seam
        return mul(p, [1.02, 1.1, 0.96][(j >> 1) % 3] * (r < 12 ? 0.94 : 1));
      }
      case Bk.BRICKS: {
        if (j % 2 === 1) return [0.62, 0.6, 0.58]; // mortar course
        if (i === (((j >> 1) % 2) ? 1 : 3)) return [0.62, 0.6, 0.58]; // staggered joint
        return mul(Bk.color(id), SHADES[(h >>> 7) % 4]);
      }
      default: return mul(Bk.color(id), r < 30 ? 0.6 : SHADES[r % 4]); // bedrock
    }
  }

  // World-space, per-color face batches for the chunks around the player.
  // Reuses the production chunk mesher verbatim; only the transport differs
  // (render-tree meshes instead of voxel.mesh bridge payloads).
  function buildMeshes(w, player, target) {
    var pcx = Math.floor(player.x / 16), pcz = Math.floor(player.z / 16);
    var yMin = Math.max(0, Math.floor(player.y) - Y_BELOW);
    var yMax = Math.min(WG().CHUNK_Y - 1, Math.floor(player.y) + Y_ABOVE);
    var buckets = {};
    for (var dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      for (var dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
        appendChunk(w, pcx + dx, pcz + dz, yMin, yMax, buckets, player.x, player.z);
      }
    }
    var meshes = [];
    for (var k in buckets) {
      if (buckets[k].faces.length) {
        meshes.push({ vertices: buckets[k].vertices, faces: buckets[k].faces, color: k });
      }
    }
    var hl = highlightMesh(w, target);
    if (hl) meshes.push(hl);
    return meshes;
  }

  function appendChunk(w, cx, cz, yMin, yMax, buckets, ex, ez) {
    var m = M().buildChunk(w, cx, cz); // chunk-local positions, quad indices
    var ox = cx * 16, oz = cz * 16;
    var P = m.positions, I = m.indices;
    var mosaic = (cx * 16 + 7.5 - ex) * (cx * 16 + 7.5 - ex) +
      (cz * 16 + 7.5 - ez) * (cz * 16 + 7.5 - ez) <= DETAIL_R2;
    for (var q = 0; q < I.length; q += 6) {
      var v0 = I[q] * 3, v1 = I[q + 1] * 3, v2 = I[q + 2] * 3, v3 = I[q + 5] * 3;
      if (P[v0 + 1] < yMin || P[v0 + 1] > yMax) continue;
      var corners = [
        [P[v0], P[v0 + 1], P[v0 + 2]], [P[v1], P[v1 + 1], P[v1 + 2]],
        [P[v2], P[v2 + 1], P[v2 + 2]], [P[v3], P[v3 + 1], P[v3 + 2]],
      ];
      // face normal from the quad winding (mesh.js CCW corner tables)
      var ax = corners[1][0] - corners[0][0], ay = corners[1][1] - corners[0][1],
        az = corners[1][2] - corners[0][2];
      var ux = corners[3][0] - corners[0][0], uy = corners[3][1] - corners[0][1],
        uz = corners[3][2] - corners[0][2];
      var nx = ay * uz - az * uy, ny = az * ux - ax * uz, nz = ax * uy - ay * ux;
      // the face's own block: one step back along the normal from the corner
      var bx = corners[0][0] + ox - (nx > 0 ? 1 : 0);
      var by = corners[0][1] - (ny > 0 ? 1 : 0);
      var bz = corners[0][2] + oz - (nz > 0 ? 1 : 0);
      var id = Facraft.world.get(w, bx, by, bz);
      if (!mosaic) { pushQuad(buckets, corners, hexRGB(B().color(id)), ox, oz); continue; }
      emitFace(buckets, corners, ox, oz, id, ny > 0 ? 2 : ny < 0 ? 0 : 1, bx, by, bz);
    }
  }

  function emitFace(buckets, corners, ox, oz, id, cls, wx, wy, wz) {
    for (var j = 0; j < MOSAIC; j++) {
      var row = [];
      for (var i = 0; i < MOSAIC; i++) {
        var c = cellColor(id, cls, wx, wy, wz, i, j);
        row.push(hex(c[0], c[1], c[2]));
      }
      var i0 = 0;
      while (i0 < MOSAIC) { // merge equal-color runs: structured faces stay cheap
        var i1 = i0 + 1;
        while (i1 < MOSAIC && row[i1] === row[i0]) i1++;
        pushCell(buckets, corners, ox, oz, row[i0], j, i0, i1);
        i0 = i1;
      }
    }
  }

  function pushCell(buckets, p, ox, oz, colorHex, j, i0, i1) {
    var N = MOSAIC, u0 = i0 / N, u1 = i1 / N, v0 = j / N, v1 = (j + 1) / N;
    var A = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]]; // v edge
    var U = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]]; // u edge
    function pt(u, v) {
      return [
        p[0][0] + U[0] * u + A[0] * v,
        p[0][1] + U[1] * u + A[1] * v,
        p[0][2] + U[2] * u + A[2] * v,
      ];
    }
    // parent winding preserved: [p0, p1(v-end), p2, p3(u-end)] analogues
    pushQuad(buckets, [pt(u0, v0), pt(u0, v1), pt(u1, v1), pt(u1, v0)], colorHex, ox, oz);
  }

  function pushQuad(buckets, vs, colorHex, ox, oz) {
    var b = buckets[colorHex];
    if (!b) b = buckets[colorHex] = { vertices: [], faces: [] };
    var base = b.vertices.length;
    for (var k = 0; k < 4; k++) {
      b.vertices.push([vs[k][0] + ox, vs[k][1], vs[k][2] + oz]);
    }
    b.faces.push([base, base + 1, base + 2], [base, base + 2, base + 3]);
  }

  // Targeted-block marker: a slightly oversized shell in a whitened block
  // color — the real raycast target, drawn where the crosshair points.
  function highlightMesh(w, target) {
    if (!target || !target.hit) return null;
    var col = B().color(Facraft.world.get(w, target.x, target.y, target.z));
    var e = 0.02; // shell oversize so the marker clears the block face
    var x = target.x - e, y = target.y - e, z = target.z - e;
    var s = 1 + 2 * e;
    var c = [
      col[0] + (1 - col[0]) * 0.45,
      col[1] + (1 - col[1]) * 0.45,
      col[2] + (1 - col[2]) * 0.45,
    ];
    var V = [
      [x, y, z], [x + s, y, z], [x + s, y + s, z], [x, y + s, z],
      [x, y, z + s], [x + s, y, z + s], [x + s, y + s, z + s], [x, y + s, z + s],
    ];
    // 6 quad faces of the cube from the 8 corners.
    var Q = [
      [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
      [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7],
    ];
    var faces = [];
    for (var i = 0; i < Q.length; i++) {
      faces.push(
        [Q[i][0], Q[i][1], Q[i][2]],
        [Q[i][0], Q[i][2], Q[i][3]]
      );
    }
    return { vertices: V, faces: faces, color: hex(c[0], c[1], c[2]) };
  }

  // The scene3d viewport node for the current frame, or null before the
  // first geometry lands (HUD falls back to the sky fill). Camera follows
  // the player eye every frame; meshes are the cached identity payload.
  function view(w, player, sky, target) {
    var dir = Facraft.physics.dirOf(player.yaw, player.pitch);
    var ex = player.x, ey = player.y + Facraft.physics.EYE_H, ez = player.z;
    var pcx = Math.floor(ex / 16), pcz = Math.floor(ez / 16);
    var key = pcx + '|' + pcz + '|' + Math.floor(player.y) + '|' +
      w.logOps.length + '|' +
      (target && target.hit ? target.x + ',' + target.y + ',' + target.z : '-');
    if (cache.key !== key) {
      cache.meshes = buildMeshes(w, player, target);
      cache.key = key;
    }
    return {
      type: 'scene3d',
      meshes: cache.meshes,
      camera: {
        position: [ex, ey, ez],
        target: [ex + dir.x, ey + dir.y, ez + dir.z],
        fov: FOV,
      },
      light: { direction: LIGHT },
      background: sky.color,
    };
  }

  return { view: view, reset: reset };
})();
