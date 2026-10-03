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

  // Per-type tone palettes: 4 deterministic tones per block. The mesher
  // picks one per block from a world-position hash and keys greedy
  // merging BY TONE, so same-tone neighbours still collapse — the world
  // reads as pixel-grain texture with zero per-frame cost and zero
  // view-dependent artifacts (unlike uv/shader texturing on the
  // software rasterizer). Tones within a palette must stay distinct
  // after *255 rounding (the merge key).
  var TONES = {};
  TONES[GRASS] = [[0.33, 0.60, 0.24], [0.38, 0.64, 0.26],
                  [0.34, 0.58, 0.29], [0.40, 0.62, 0.23]];
  // Grass SIDE faces read as dirt with a green tint (Minecraft grass
  // block: brown sides, green top) — kills the "all green" flat look.
  var GRASS_SIDE = [[0.44, 0.36, 0.22], [0.48, 0.39, 0.24],
                    [0.42, 0.34, 0.23], [0.46, 0.38, 0.21]];
  TONES[DIRT] = [[0.45, 0.33, 0.21], [0.51, 0.37, 0.24],
                 [0.47, 0.36, 0.26], [0.50, 0.34, 0.22]];
  TONES[STONE] = [[0.52, 0.52, 0.54], [0.58, 0.58, 0.60],
                  [0.54, 0.55, 0.56], [0.50, 0.51, 0.53]];
  TONES[LOG] = [[0.40, 0.29, 0.17], [0.45, 0.33, 0.19],
                [0.38, 0.28, 0.16], [0.43, 0.32, 0.20]];
  TONES[LEAVES] = [[0.22, 0.44, 0.18], [0.26, 0.48, 0.21],
                   [0.20, 0.42, 0.22], [0.25, 0.46, 0.17]];
  TONES[SAND] = [[0.80, 0.73, 0.50], [0.84, 0.77, 0.54],
                 [0.78, 0.72, 0.53], [0.83, 0.74, 0.49]];
  TONES[PLANKS] = [[0.70, 0.54, 0.32], [0.74, 0.58, 0.35],
                   [0.68, 0.53, 0.34], [0.72, 0.57, 0.31]];
  TONES[BRICKS] = [[0.56, 0.30, 0.25], [0.61, 0.34, 0.27],
                   [0.54, 0.31, 0.28], [0.59, 0.33, 0.24]];
  TONES[BEDROCK] = [[0.16, 0.16, 0.18], [0.20, 0.20, 0.22],
                    [0.17, 0.17, 0.21], [0.19, 0.18, 0.19]];

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
    // side=true -> the block's vertical-face palette (grass gets dirt
    // sides); everything else uses the one per-type palette.
    palette: function(id, side) {
      if (id === GRASS && side) return GRASS_SIDE;
      return TONES[id] || TONES[STONE];
    },
    name: function(id) { return NAMES[id] || '?'; },
  };
})();
