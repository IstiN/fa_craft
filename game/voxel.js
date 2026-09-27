// Voxel host adapter (I1: the only file that knows the runtime voxel
// capability). The mesh/camera contract is a pure-Dart voxel/mesh node to be
// added upstream to flutter_js_widget_runtime (I4: no native deps); this repo
// pins that PR's commit hash in the PR body until it ships. Until the host
// provides it, the adapter degrades gracefully: sim + HUD keep running and a
// notice explains what is missing.
var Facraft = Facraft || {};
Facraft.voxel = (function() {
  var attached = false, degraded = false, attachTried = false;
  var ID = 'fa-craft';

  function reset() { attached = false; degraded = false; attachTried = false; }

  function attach(jsr) {
    if (attachTried) return;
    attachTried = true;
    jsr.hostCall('voxel.attach', { id: ID }).then(function() {
      attached = true;
    }, function() {
      degraded = true; // no voxel node in this host yet (E6-style visible fallback)
    });
  }

  // Upload dirty chunk meshes + sync the camera. Bridge-call budget: at most
  // one call per dirty chunk + one camera call per frame; zero when clean.
  function sync(jsr, world, player, eye, sky) {
    if (degraded) return;
    if (!attached) { attach(jsr); if (!attached) return; }
    var built = Facraft.mesh.rebuildDirty(world);
    for (var i = 0; i < built.length; i++) {
      var m = world.meshes.get(built[i]);
      jsr.hostCall('voxel.mesh', {
        id: ID, key: built[i], origin: m.origin,
        positions: m.positions, colors: m.colors, indices: m.indices,
      }).catch(function() { degraded = true; });
    }
    jsr.hostCall('voxel.camera', {
      id: ID,
      position: [eye.x, eye.y, eye.z],
      yaw: player.yaw, pitch: player.pitch,
      light: sky.light, skyColor: sky.color,
    }).catch(function() { degraded = true; });
  }

  return { sync: sync, reset: reset, isDegraded: function() { return degraded; }, isAttached: function() { return attached; }, ID: ID };
})();
