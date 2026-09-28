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

  // Per-block checker tint: even top-lit faces stay readable as individual
  // blocks instead of one flat wash.
  var CHECKER = 0.07;

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
        appendChunk(w, pcx + dx, pcz + dz, yMin, yMax, buckets);
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

  function appendChunk(w, cx, cz, yMin, yMax, buckets) {
    var m = M().buildChunk(w, cx, cz); // chunk-local positions, per-vertex colors, quad indices
    var ox = cx * 16, oz = cz * 16;
    var P = m.positions, C = m.colors, I = m.indices;
    for (var q = 0; q < I.length; q += 6) {
      var v0 = I[q] * 3;
      var vy = P[v0 + 1];
      if (vy < yMin || vy > yMax) continue;
      var wx = P[v0] + ox, wz = P[v0 + 2] + oz;
      var tint = ((wx + wz) & 1) === 0 ? 1 : 1 - CHECKER;
      var color = hex(C[v0] * tint, C[v0 + 1] * tint, C[v0 + 2] * tint);
      var bucket = buckets[color];
      if (!bucket) bucket = buckets[color] = { vertices: [], faces: [] };
      var base = bucket.vertices.length;
      // mesh.js quads: indices [b, b+1, b+2, b, b+2, b+3] — corners b..b+3.
      for (var v = 0; v < 4; v++) {
        var vi = I[q + (v === 3 ? 5 : v)] * 3;
        bucket.vertices.push([P[vi] + ox, P[vi + 1], P[vi + 2] + oz]);
      }
      bucket.faces.push([base, base + 1, base + 2], [base, base + 2, base + 3]);
    }
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
