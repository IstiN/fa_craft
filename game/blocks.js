// Block palette shared by worldgen, meshing, crafting, HUD.
var Facraft = Facraft || {};
Facraft.blocks = (function() {
  var AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, LOG = 4, LEAVES = 5,
    SAND = 6, PLANKS = 7, BRICKS = 8, BEDROCK = 9;

  var NAMES = ['air', 'grass', 'dirt', 'stone', 'log', 'leaves', 'sand', 'planks', 'bricks', 'bedrock'];

  // Mesh colors [r,g,b] 0..1 per block id.
  var RGB = {};
  RGB[GRASS] = [0.35, 0.62, 0.26];
  RGB[DIRT] = [0.48, 0.35, 0.23];
  RGB[STONE] = [0.55, 0.55, 0.57];
  RGB[LOG] = [0.42, 0.31, 0.18];
  RGB[LEAVES] = [0.24, 0.46, 0.2];
  RGB[SAND] = [0.82, 0.75, 0.52];
  RGB[PLANKS] = [0.72, 0.56, 0.34];
  RGB[BRICKS] = [0.58, 0.32, 0.26];
  RGB[BEDROCK] = [0.18, 0.18, 0.2];

  var SOLID = [];
  SOLID[AIR] = false;
  SOLID[BEDROCK] = true;
  for (var i = 1; i <= 8; i++) SOLID[i] = true;

  return {
    AIR: AIR, GRASS: GRASS, DIRT: DIRT, STONE: STONE, LOG: LOG, LEAVES: LEAVES,
    SAND: SAND, PLANKS: PLANKS, BRICKS: BRICKS, BEDROCK: BEDROCK,
    MAX: BEDROCK,
    isSolid: function(id) { return SOLID[id] === true; },
    color: function(id) { return RGB[id] || RGB[STONE]; },
    name: function(id) { return NAMES[id] || '?'; },
  };
})();
