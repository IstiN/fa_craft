// HUD: declarative JSON UI around the voxel viewport — crosshair, hotbar,
// hearts, notices, F3-style debug, crafting sheet, death dialog, touch pads.
// Pure: build the tree from state; jsr.render replaces the whole thing.
var Facraft = Facraft || {};
Facraft.hud = (function() {
  var B = function() { return Facraft.blocks; };

  function hotbarBlocks() {
    var b = B();
    return [b.GRASS, b.DIRT, b.STONE, b.LOG, b.LEAVES, b.SAND, b.PLANKS, b.BRICKS];
  }

  function slot(state, t, id, index) {
    var selected = state.selected === index;
    var count = state.world.mode === 'creative' ? '∞' : String(state.world.inventory[id] || 0);
    var c = B().color(id);
    return {
      type: 'container', hotbarIndex: index,
      width: 40, height: 44,
      decoration: {
        color: t.surface,
        borderRadius: 6,
        border: { color: selected ? t.accent : t.border, width: selected ? 2 : 1 },
      },
      child: {
        type: 'column', mainAxisSize: 'min', children: [
          { type: 'rect', width: 22, height: 9, fill: swatch(c) },
          { type: 'text', data: B().name(id), style: { fontSize: 10, color: selected ? t.accent : t.text } },
          { type: 'text', data: count, style: { fontSize: 10, color: t.muted } },
        ],
      },
    };
  }

  function swatch(c) {
    function cc(v) {
      var x = Math.max(0, Math.min(255, Math.round(v * 255)));
      return (x < 16 ? '0' : '') + x.toString(16);
    }
    return '#' + cc(c[0]) + cc(c[1]) + cc(c[2]);
  }

  function build(state, t) {
    var F = Facraft;
    var w = state.world;
    var sky = F.daynight.sky(w.dayTime);
    var hearts = [];
    var filled = Math.ceil(w.health / 2);
    for (var h = 0; h < filled; h++) {
      hearts.push({ type: 'icon', icon: 'favorite', heart: true, color: '#ef4444', size: 16 });
    }

    var hotbar = { type: 'row', mainAxisSize: 'min', children: [] };
    var hb = hotbarBlocks();
    for (var i = 0; i < hb.length; i++) hotbar.children.push(slot(state, t, hb[i], i + 1));

    var overlays = [];

    if (state.notice) {
      overlays.push({
        type: 'container', positioned: { left: 16, right: 16, bottom: 272 },
        decoration: { color: t.surface, borderRadius: 8, border: { color: t.borderBright, width: 1 } },
        padding: [10, 6, 10, 6],
        child: { type: 'text', data: state.notice, style: { fontSize: 12, color: t.text } },
      });
    }
    if (state.hint) {
      overlays.push({
        type: 'container', positioned: { left: 0, right: 0, bottom: 168 },
        child: { type: 'center', child: { type: 'text', data: 'Drag to look · drag the pad to walk', style: { fontSize: 11, color: t.muted }, width: 320 } },
      });
    }
    if (state.debug) {
      overlays.push({
        type: 'container', positioned: { left: 8, top: 8 },
        decoration: { color: '#00000088', borderRadius: 4 }, padding: [6, 4, 6, 4],
        child: { type: 'text', debugOverlay: true, lines: debugLines(state), data: debugLines(state).join('\n'), style: { fontSize: 10, color: '#a7f3d0' } },
      });
    }

    var gameStack = {
      type: 'stack', children: [
        { // viewport area: drag = look, tap = place; the scene3d node paints
          // the real world (software meshes, sky-colored background).
          // Positioned on all four edges so the scene gets tight full-bleed
          // constraints (no aspect box).
          type: 'container', positioned: { left: 0, top: 0, right: 0, bottom: 0 },
          child: {
            type: 'gestureDetector', onTap: 'place', onPanUpdate: 'look',
            child: F.voxel.view(w, w.player, sky, state.target),
          },
        },
        { // virtual joystick pad (touch walk) — parked above the hotbar strip:
          // at bottom-left it painted over the first hotbar slot
          type: 'container', positioned: { left: 16, bottom: 64 },
          child: {
            type: 'gestureDetector', onPanUpdate: 'joyMove', onPanEnd: 'joyEnd',
            child: {
              type: 'container', width: 96, height: 96,
              decoration: { color: t.surfaceAlt, borderRadius: 48, border: { color: t.borderBright, width: 1 } },
              child: { type: 'center', child: { type: 'text', data: 'move', style: { fontSize: 10, color: t.muted } } },
            },
          },
        },
        { // crosshair
          type: 'center', child: {
            type: 'column', mainAxisSize: 'min', children: [
              { type: 'rect', width: 2, height: 14, fill: '#ffffffcc' },
              { type: 'sizedBox', height: 0 },
              { type: 'rect', width: 14, height: 2, fill: '#ffffffcc' },
            ],
          },
        },
        { // top action bar
          type: 'container', positioned: { left: 0, right: 0, top: 0 },
          padding: [8, 8, 8, 8],
          child: {
            type: 'row', children: [
              { type: 'textButton', text: 'Break', onTap: 'break', style: { backgroundColor: t.surface, foregroundColor: t.text } },
              { type: 'textButton', text: 'Craft', onTap: 'craft', style: { backgroundColor: t.surface, foregroundColor: t.text } },
              { type: 'textButton', text: 'Mode', onTap: 'mode', style: { backgroundColor: t.surface, foregroundColor: t.text } },
              { type: 'textButton', text: 'Fly', onTap: 'fly', style: { backgroundColor: t.surface, foregroundColor: t.text } },
              { type: 'textButton', text: 'F3', onTap: 'debug', style: { backgroundColor: t.surface, foregroundColor: t.text } },
            ],
          },
        },
        { // hearts (survival, alive)
          type: 'container', positioned: { left: 0, right: 0, bottom: 76 },
          child: { type: 'center', child: { type: 'row', mainAxisSize: 'min', children: hearts } },
        },
        { // hotbar
          type: 'container', positioned: { left: 0, right: 0, bottom: 12 },
          child: { type: 'center', child: hotbar },
        },
      ],
    };
    for (var o = 0; o < overlays.length; o++) gameStack.children.push(overlays[o]);

    var root = {
      type: 'listView', shrinkWrap: false, physics: 'never',
      children: [gameStack],
    };

    if (state.craftOpen) {
      root = {
        type: 'stack', children: [root, craftSheet(t)],
      };
    }
    if (w.dead) {
      root = {
        type: 'stack', children: [root, {
          type: 'dialog', deathDialog: true, title: 'You died', dismissible: false,
          message: 'Respawn to keep building. Your blocks are safe.',
          actions: [{ label: 'Respawn', onTap: 'respawn' }],
        }],
      };
    }
    return root;
  }

  function craftSheet(t) {
    var rows = [];
    var recipes = Facraft.craft.recipes;
    for (var i = 0; i < recipes.length; i++) {
      var r = recipes[i];
      rows.push({
        type: 'textButton', text: r.id + ' — craft 1', onTap: 'craftRecipe', payload: { id: r.id },
        style: { backgroundColor: t.surfaceAlt, foregroundColor: t.text },
      });
    }
    rows.push({ type: 'textButton', text: 'Close', onTap: 'closeCraft', style: { foregroundColor: t.muted } });
    return {
      type: 'bottomSheet', craftSheet: true, height: 260, color: t.surface,
      // top padding keeps recipe rows clear of the hotbar band while the
      // runtime's modal slide-up animation settles (goldens freeze it early)
      child: { type: 'padding', padding: [16, 48, 16, 12], child: { type: 'column', children: rows } },
    };
  }

  function debugLines(state) {
    var p = state.world.player;
    return [
      'pos ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ' + p.z.toFixed(1),
      'fps ' + Math.round(state.fps || 0),
      'chunks ' + state.world.meshes.size,
      'day ' + state.world.dayTime.toFixed(0),
      'mode ' + state.world.mode,
      'edits ' + state.world.logOps.length,
    ];
  }

  return { build: build, hotbarBlocks: hotbarBlocks };
})();
