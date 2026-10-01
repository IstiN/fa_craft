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

  // ---- illustrated faces ----
  // The 0.4.126 scene3d mesh node is colors-only (vertices + faces + flat
  // albedo), so block "textures" are built geometrically: near-field faces
  // subdivide into a MOSAIC x MOSAIC grid whose cells pick from a
  // per-block-type palette through a position-seeded hash — deterministic
  // across frames and runs, varied per block. Equal-color row runs merge
  // into one quad, so structured faces (planks, bricks, bark) stay cheap.
  var MOSAIC = 4;
  var DETAIL_R2 = 30 * 30; // chunk-center distance²: nearer chunks mosaic, the far field keeps one quad per face (keeps rebuilds tied to the existing chunk-pair cache key)
  var SHADES = [0.7, 0.86, 1.0, 1.16];
  // per-block hue jitter: whole blocks drift apart in tint so the terrain
  // reads as distinct blocks, not one wash
  var HUES = [
    [1, 1, 1], [0.9, 1.04, 0.92], [1.06, 0.94, 0.88],
    [0.94, 1.06, 1.02], [1, 0.95, 1.05],
  ];

  function h32(a, b, c, d) {
    var x = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791) ^ ((d | 0) * 2654435761);
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return (x ^ (x >>> 16)) >>> 0;
  }

  function mul(c, m) { return [c[0] * m, c[1] * m, c[2] * m]; }

  function soil(d, r) {
    if (r < 16) return mul(d, 0.6); // clod shadow
    return mul(d, r < 30 ? 1.18 : SHADES[r % 4]);
  }

  // Per-block-type mosaic cell painters: (id, cls, i, j, r, h) -> [r, g, b].
  // r = h % 100 is the per-cell jitter roll; h the full hash (spare bits for
  // stripes). Splitting the old monolithic switch keeps each block's logic
  // single-purpose and the CRAP gate happy; painting math is unchanged.
  function grassCell(id, cls, i, j, r, h) {
    var g = B().color(id);
    var edge = cls === 2 && (i === 0 || i === MOSAIC - 1 || j === 0 || j === MOSAIC - 1);
    var turf = (cls === 2) || (cls === 1 && (j >= MOSAIC - 1 ||
      (j === MOSAIC - 2 && (h >>> 7) % 100 < 45))); // turf overhang fringe
    if (turf) {
      if (edge && r < 30) return mul(g, 0.5); // blade notch on the face border
      if (edge) return mul(g, 0.8); // shaded turf edge
      if (r < 14) return [g[0] * 1.35, g[1] * 1.1, g[2] * 0.5]; // dry blade
      if (r < 30) return mul(g, 0.6); // dark tuft
      return mul(g, SHADES[r % 4]);
    }
    return soil(B().color(B().DIRT), r);
  }

  function dirtCell(id, cls, i, j, r) { return soil(B().color(id), r); }

  function stoneCell(id, cls, i, j, r) {
    var s = B().color(id);
    if (r < 14) return mul(s, 0.62); // crack
    return mul(s, r < 30 ? 1.2 : SHADES[r % 4]);
  }

  function logCell(id, cls, i, j, r) {
    var l = B().color(id);
    if (cls === 1) { // bark: vertical striping + grain jitter
      var stripe = [0.72, 1.06, 0.82, 1.12][i];
      return mul(l, r < 12 ? stripe * 0.85 : stripe);
    }
    var ring = Math.floor(Math.max(Math.abs(i - 1.5), Math.abs(j - 1.5))); // end-grain rings
    return mul(l, (ring % 2 ? 0.7 : 1.1) * (r < 12 ? 0.88 : 1));
  }

  function leavesCell(id, cls, i, j, r) {
    var lv = B().color(id);
    if (r < 18) return mul(lv, 0.55); // depth hole
    return mul(lv, r < 40 ? 1.25 : SHADES[r % 4]);
  }

  function sandCell(id, cls, i, j, r) {
    var sa = B().color(id);
    return mul(sa, r < 16 ? 0.8 : r < 30 ? 1.14 : SHADES[r % 4]);
  }

  function planksCell(id, cls, i, j, r) {
    var p = B().color(id);
    if (j % 2 === 1) return mul(p, 0.68); // board seam
    return mul(p, [1.06, 1.16, 0.92][(j >> 1) % 3] * (r < 12 ? 0.9 : 1));
  }

  function bricksCell(id, cls, i, j, r, h) {
    if (j % 2 === 1) return [0.66, 0.64, 0.62]; // mortar course
    if (i === (((j >> 1) % 2) ? 1 : 3)) return [0.66, 0.64, 0.62]; // staggered joint
    return mul(B().color(id), SHADES[(h >>> 7) % 4]);
  }

  function bedrockCell(id, cls, i, j, r) {
    return mul(B().color(id), r < 30 ? 0.55 : SHADES[r % 4]);
  }

  var PAINTERS = null;
  function painterFor(id) {
    if (!PAINTERS) {
      var Bk = B();
      PAINTERS = {};
      PAINTERS[Bk.GRASS] = grassCell;
      PAINTERS[Bk.DIRT] = dirtCell;
      PAINTERS[Bk.STONE] = stoneCell;
      PAINTERS[Bk.LOG] = logCell;
      PAINTERS[Bk.LEAVES] = leavesCell;
      PAINTERS[Bk.SAND] = sandCell;
      PAINTERS[Bk.PLANKS] = planksCell;
      PAINTERS[Bk.BRICKS] = bricksCell;
    }
    return PAINTERS[id] || bedrockCell; // unknown ids fall through to bedrock
  }

  // One mosaic cell's albedo. cls: 0 bottom / 1 side / 2 top; v rows run
  // bottom→top on side faces (mesh.js corner tables), so j = MOSAIC-1 is the
  // face's top edge.
  function cellColor(id, cls, wx, wy, wz, i, j) {
    var h = h32(wx, wy, wz, (cls << 6) | (i * MOSAIC + j));
    var r = h % 100;
    var hue = HUES[h32(wx, wy, wz, 0x5eed) % HUES.length]; // per-block tint
    var c = painterFor(id)(id, cls, i, j, r, h);
    return [c[0] * hue[0], c[1] * hue[1], c[2] * hue[2]];
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
      // ponytail: far field = ONE hash-picked mosaic cell per face (no
      // subdivision) — per-block tonal variation without a seam ring where
      // the mosaic circle ends; raise MOSAIC before widening this if faces
      // ever need more than 4x4 near-field detail.
      if (!mosaic) {
        var fc = cellColor(id, ny > 0 ? 2 : ny < 0 ? 0 : 1, bx, by, bz, 0, 0);
        pushQuad(buckets, corners, hex(fc[0], fc[1], fc[2]), ox, oz);
        continue;
      }
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

  // ---- native voxel node (I4) ----
  // js_widget_runtime 0.4.127+ owns a bridge-side voxel world: chunk buffers
  // cross the bridge ONCE per chunk (and per edit) via voxel.mesh and the
  // per-frame traffic shrinks to one tiny voxel.camera call. The legacy
  // scene3d path below re-sent every chunk's full mesh JSON every frame —
  // on the web worker build that multi-hundred-KB per-frame payload is what
  // made walking crawl. view() branches on the probe result.
  var NATIVE_ID = 'fa-craft';
  var nativeOn = null; // null = probe in flight; true/false once it lands
  var uploaded = {};   // chunk key -> true (re-upload driven by w.dirty)
  var hlCell = '';     // last uploaded highlight cell key

  function isNative() { return nativeOn === true; }

  function probe() {
    jsr.hostCall('voxel.attach', { id: NATIVE_ID }).then(
      function() { nativeOn = true; },
      function() { nativeOn = false; }
    );
  }

  // Fire-and-forget with a swallowed rejection: the bridge resolves voxel.*
  // itself, but a rejecting/absent handler must never wedge the game loop
  // (and the test harness counts calls without registering handlers).
  function push(name, args) {
    jsr.hostCall(name, args).then(function() {}, function() {});
  }

  // Per-face shading without the legacy path's 16x mosaic subdivision:
  // block hue jitter + a top/side/bottom brightness class, applied to the
  // four corner colors of every quad buildChunk emitted. Runs once per
  // chunk upload, not per frame.
  function shadeFaces(m, cx, cz) {
    var P = m.positions, C = m.colors, I = m.indices;
    var CLS = [0.62, 0.82, 1.0]; // bottom, side, top
    for (var q = 0; q < I.length; q += 6) {
      var v0 = I[q] * 3, v1 = I[q + 1] * 3, v3 = I[q + 5] * 3;
      var ax = P[v1] - P[v0], ay = P[v1 + 1] - P[v0 + 1], az = P[v1 + 2] - P[v0 + 2];
      var ux = P[v3] - P[v0], uy = P[v3 + 1] - P[v0 + 1], uz = P[v3 + 2] - P[v0 + 2];
      var ny = az * ux - ax * uz;
      var s = CLS[ny > 0 ? 2 : ny < 0 ? 0 : 1];
      // Per-CORNER hue jitter: the painter interpolates vertex colors, so
      // greedy-merged quads get a smooth per-block gradient instead of one
      // flat tint. Adjacent quads sharing a corner hash it identically.
      var vs = [I[q], I[q + 1], I[q + 2], I[q + 5]];
      for (var v = 0; v < 4; v++) {
        var b = vs[v] * 3;
        var hue = HUES[h32(
          Math.round(cx * 16 + P[b]), Math.round(P[b + 1]),
          Math.round(cz * 16 + P[b + 2]), 0x5eed) % HUES.length];
        C[b] = Math.min(1, C[b] * hue[0] * s);
        C[b + 1] = Math.min(1, C[b + 1] * hue[1] * s);
        C[b + 2] = Math.min(1, C[b + 2] * hue[2] * s);
      }
    }
  }

  function uploadChunk(w, cx, cz, prof) {
    var m = M().buildChunk(w, cx, cz);
    shadeFaces(m, cx, cz);
    push('voxel.mesh', {
      id: NATIVE_ID, key: cx + ',' + cz,
      origin: m.origin, positions: m.positions,
      colors: m.colors, indices: m.indices,
    });
    uploaded[cx + ',' + cz] = true;
    // ensureArea re-marks every chunk missing from w.meshes each frame —
    // a sentinel entry stops the loop (the legacy renderer never fills it).
    w.meshes.set(cx + ',' + cz, true);
    if (prof) {
      prof.uploads++;
      prof.meshBytes += (m.positions.length + m.colors.length + m.indices.length) * 4;
    }
  }

  // Upload the chunks of the view ring that are new or dirty. Dirty chunks
  // outside the ring stay marked and upload when the ring reaches them.
  // When the player crosses a chunk boundary, chunks beyond the ring+1
  // margin are evicted (voxel.chunkRemove) so long walks do not grow the
  // resident set — and the per-frame painter triangle count — forever.
  var lastEvictPcx = null, lastEvictPcz = null;

  function sync(w, player, prof) {
    if (!isNative()) return;
    var pcx = Math.floor(player.x / 16), pcz = Math.floor(player.z / 16);
    for (var dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      for (var dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
        var cx = pcx + dx, cz = pcz + dz, key = cx + ',' + cz;
        if (uploaded[key] && !w.dirty.has(key)) continue;
        uploadChunk(w, cx, cz, prof);
        w.dirty.delete(key);
      }
    }
    if (pcx !== lastEvictPcx || pcz !== lastEvictPcz) {
      lastEvictPcx = pcx; lastEvictPcz = pcz;
      for (var key in uploaded) {
        var parts = key.split(',');
        var kx = parseInt(parts[0], 10), kz = parseInt(parts[1], 10);
        if (Math.abs(kx - pcx) > VIEW_RADIUS + 1 ||
            Math.abs(kz - pcz) > VIEW_RADIUS + 1) {
          push('voxel.chunkRemove', { id: NATIVE_ID, key: key });
          delete uploaded[key];
        }
      }
    }
  }

  function flattenMesh(mesh) { // {vertices:[[x,y,z]],faces,color} -> flat arrays
    var positions = [], colors = [], indices = [];
    var rgb = hexToRgb(mesh.color);
    for (var i = 0; i < mesh.vertices.length; i++) {
      positions.push(mesh.vertices[i][0], mesh.vertices[i][1], mesh.vertices[i][2]);
      colors.push(rgb[0], rgb[1], rgb[2]);
    }
    for (var f = 0; f < mesh.faces.length; f++) {
      indices.push(mesh.faces[f][0], mesh.faces[f][1], mesh.faces[f][2]);
    }
    return { positions: positions, colors: colors, indices: indices };
  }

  function hexToRgb(h) {
    return [
      parseInt(h.substr(1, 2), 16) / 255,
      parseInt(h.substr(3, 2), 16) / 255,
      parseInt(h.substr(5, 2), 16) / 255,
    ];
  }

  // Targeted-block marker as a resident '__hl' chunk: replaced wholesale
  // whenever the aim cell changes (the runtime has no voxel.chunkRemove
  // yet, so an empty aim parks a zero-area quad at the origin instead).
  function highlight(w, target) {
    if (!isNative()) return;
    var cell = target && target.hit ? target.x + ',' + target.y + ',' + target.z : '';
    if (cell === hlCell) return;
    hlCell = cell;
    var mesh = cell ? highlightMesh(w, target) : null;
    var flat = mesh ? flattenMesh(mesh)
      : { positions: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          colors: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          indices: [0, 1, 2, 0, 2, 3] };
    push('voxel.mesh', {
      id: NATIVE_ID, key: '__hl', origin: [0, 0, 0],
      overlay: true, // depth-biased in the painter: wins over the coplanar face
      positions: flat.positions, colors: flat.colors, indices: flat.indices,
    });
  }

  // One tiny bridge call per frame — the whole per-frame 3D cost natively.
  function camera(w, player, sky) {
    if (!isNative()) return;
    push('voxel.camera', {
      id: NATIVE_ID,
      position: [player.x, player.y + Facraft.physics.EYE_H, player.z],
      yaw: player.yaw, pitch: player.pitch,
      light: sky.light, skyColor: sky.color, fov: FOV,
      // Pixelated block look: the painter modulates triangles with a
      // 16px-per-block procedural noise tile.
      texture: true,
    });
  }

  // The viewport node for the current frame. Native: a bare voxel node —
  // geometry lives bridge-side, the render tree carries none of it.
  // Pending/failed probe or older runtimes: the legacy scene3d meshes path.
  function view(w, player, sky, target) {
    if (nativeOn === true) return { type: 'voxel', id: NATIVE_ID };
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

  function reset() {
    cache.key = null; cache.meshes = null;
    uploaded = {}; hlCell = '';
  }

  return {
    view: view, reset: reset,
    probe: probe, isNative: isNative,
    sync: sync, camera: camera, highlight: highlight,
    // Resident-chunk primitives for dynamic actors (mobs): uploadMesh
    // replaces a chunk wholesale, removeMesh evicts it (despawn).
    uploadMesh: function(key, flat) {
      if (!isNative()) return;
      push('voxel.mesh', {
        id: NATIVE_ID, key: key, origin: flat.origin,
        positions: flat.positions, colors: flat.colors,
        indices: flat.indices,
      });
    },
    removeMesh: function(key) {
      if (!isNative()) return;
      push('voxel.chunkRemove', { id: NATIVE_ID, key: key });
    },
  };
})();
