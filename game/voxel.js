// Voxel host adapter (I4: the only file that knows the runtime 3D
// capability). Chunk buffers cross the bridge ONCE per chunk via
// voxel.mesh, each frame costs one tiny voxel.camera call, and the render
// tree carries a bare {type:'voxel'} node. js_widget_runtime >= 0.4.156
// is required: a failed (or hung) capability probe renders a static
// update card — there is no software meshes fallback.
var Facraft = Facraft || {};
Facraft.voxel = (function() {
  var M = function() { return Facraft.mesh; };

  var VIEW_RADIUS = 2;  // chunk radius meshed/uploaded
  var FOV = 72;

  // ---- native voxel node (I4) ----
  // js_widget_runtime 0.4.127+ owns a bridge-side voxel world: chunk
  // buffers cross the bridge ONCE per chunk (and per edit) via voxel.mesh
  // and the per-frame traffic shrinks to one tiny voxel.camera call. A
  // failed probe renders the update card — no scene3d meshes path exists.
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
    // A probe that never settles (pre-0.4.156 JSC: __jsr_host_call not
    // registered) must surface the update card too — fail it after ~2 s.
    setTimeout(function() { if (nativeOn === null) nativeOn = false; }, 2000);
  }

  // Fire-and-forget with a swallowed rejection: the bridge resolves voxel.*
  // itself, but a rejecting/absent handler must never wedge the game loop
  // (and the test harness counts calls without registering handlers).
  function push(name, args) {
    jsr.hostCall(name, args).then(function() {}, function() {});
  }

  // Per-face shading: a top/side/bottom brightness class, applied to the
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
      // Flat per-quad tint: per-corner jitter on a greedy-merged quad
      // interpolates into WAVY gradient bands after the painter's texture
      // subdivision — the noise tile owns the pixel detail now, so the
      // face keeps one straight brightness class (Minecraft-flat look).
      var vs = [I[q], I[q + 1], I[q + 2], I[q + 5]];
      for (var v = 0; v < 4; v++) {
        var b = vs[v] * 3;
        C[b] = Math.min(1, C[b] * s);
        C[b + 1] = Math.min(1, C[b + 1] * s);
        C[b + 2] = Math.min(1, C[b + 2] * s);
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
    // a sentinel entry stops the loop (only this uploader fills w.meshes).
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

  // Aimed-face marker: a bright border RING on the raycast entry face —
  // top face when looking down, side face when facing a wall. Reads as a
  // selection outline (Minecraft-style) instead of a shaded blob.
  // Face tables mirror mesh.js (CCW-from-outside winding contract).
  var HL_AXES = [[1, 2], [1, 2], [0, 2], [0, 2], [0, 1], [0, 1]];
  var HL_CORNERS = [
    [[0, 0], [1, 0], [1, 1], [0, 1]], // +x
    [[0, 1], [1, 1], [1, 0], [0, 0]], // -x
    [[0, 0], [0, 1], [1, 1], [1, 0]], // +y
    [[0, 0], [1, 0], [1, 1], [0, 1]], // -y
    [[1, 0], [1, 1], [0, 1], [0, 0]], // +z
    [[0, 0], [0, 1], [1, 1], [1, 0]], // -z
  ];
  var HL_LIFT = 0.004; // off the surface — no coplanar flicker
  var HL_INSET = 0.10; // border thickness, in blocks

  function faceOutlineMesh(t) {
    var n = [t.nx, t.ny, t.nz];
    var A = n[0] !== 0 ? 0 : (n[1] !== 0 ? 1 : 2);
    var positive = n[A] > 0;
    var f = A * 2 + (positive ? 0 : 1);
    var U = HL_AXES[f][0], V = HL_AXES[f][1];
    var a = positive ? 1 + HL_LIFT : -HL_LIFT;
    var base = [t.x, t.y, t.z];
    // corner point of rect (u0,u1,v0,v1) at sign (su, sv)
    function corner(su, sv, u0, u1, v0, v1) {
      var q = [0, 0, 0];
      q[A] = base[A] + a;
      q[U] = base[U] + (su ? u1 : u0);
      q[V] = base[V] + (sv ? v1 : v0);
      return q;
    }
    var cs = HL_CORNERS[f];
    var P = [], C = [], I = [];
    var o = [-HL_LIFT, 1 + HL_LIFT], inn = [HL_INSET, 1 - HL_INSET];
    for (var k = 0; k < 4; k++) {
      var k2 = (k + 1) % 4;
      var quad = [
        corner(cs[k][0], cs[k][1], o[0], o[1], o[0], o[1]),
        corner(cs[k2][0], cs[k2][1], o[0], o[1], o[0], o[1]),
        corner(cs[k2][0], cs[k2][1], inn[0], inn[1], inn[0], inn[1]),
        corner(cs[k][0], cs[k][1], inn[0], inn[1], inn[0], inn[1]),
      ];
      var vb = P.length / 3;
      for (var v = 0; v < 4; v++) {
        P.push(quad[v][0], quad[v][1], quad[v][2]);
        C.push(1, 1, 1); // bright — reads on any block, day or night
      }
      I.push(vb, vb + 1, vb + 2, vb, vb + 2, vb + 3);
    }
    return { positions: P, colors: C, indices: I };
  }

  // Targeted-block marker as a resident '__hl' chunk: replaced wholesale
  // whenever the aim cell OR the aimed face changes (an empty aim parks
  // a zero-area quad at the origin instead of a chunkRemove, so older
  // runtimes keep working).
  function highlight(w, target) {
    if (!isNative()) return;
    var cell = target && target.hit
      ? target.x + ',' + target.y + ',' + target.z + ',' +
        target.nx + ',' + target.ny + ',' + target.nz
      : '';
    if (cell === hlCell) return;
    hlCell = cell;
    var flat = cell ? faceOutlineMesh(target)
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
      // No shader-noise texturing: affine uv on a software rasterizer
      // can only be tamed by adaptive subdivision, and every variant of
      // that (w1..w5) traded one artifact for another — swimming, band
      // pops, diagonal creases, contrast boundaries — at 20-60k tris.
      // The blocky texture feel lives in the mesher's per-block jitter.
      texture: false,
    });
  }

  // The viewport node for the current frame. Native-only: geometry lives
  // bridge-side, the render tree carries none of it. While the probe is
  // in flight the bare voxel node is already correct on any runtime that
  // can run the game; a failed (or 2 s-timed-out) probe renders a static
  // update card instead of any world geometry.
  function view() {
    if (nativeOn !== false) return { type: 'voxel', id: NATIVE_ID };
    var t = jsr.theme;
    return {
      type: 'container', decoration: { color: t.bg },
      child: {
        type: 'center',
        child: {
          type: 'text',
          data: 'fa-craft needs js_widget_runtime >= 0.4.156 — update the app',
          style: { fontSize: 14, color: t.text },
          width: 320,
        },
      },
    };
  }

  function reset() {
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
