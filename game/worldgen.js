// Deterministic, seeded, chunked world generation (terrain, biomes-lite,
// caves). Same seed + same coords → identical bytes on every engine.
var Facraft = Facraft || {};
Facraft.worldgen = (function() {
  var N = function() { return Facraft.noise; };
  var B = function() { return Facraft.blocks; };

  var CHUNK_X = 16, CHUNK_Y = 64, CHUNK_Z = 16;

  function index(lx, y, lz) { return (y * CHUNK_Z + lz) * CHUNK_X + lx; }

  // Surface height for a world column.
  function height(seed, wx, wz) {
    var base = N().fbm2(seed, wx * 0.012, wz * 0.012, 4); // [-1,1]
    var detail = N().fbm2(seed + 555, wx * 0.06, wz * 0.06, 2);
    var h = 24 + base * 16 + detail * 3;
    return Math.max(4, Math.min(CHUNK_Y - 6, Math.round(h)));
  }

  function surfaceBlock(seed, wx, wz, h) {
    if (h > 34) return B().STONE; // mountains
    var sand = N().value2(seed + 91, wx * 0.05, wz * 0.05);
    if (h < 18 || sand > 0.55) return B().SAND; // lowlands / sandy patches
    return B().GRASS;
  }

  function isCave(seed, wx, wy, wz) {
    if (wy < 2) return false;
    return N().fbm3(seed + 777, wx * 0.09, wy * 0.11, wz * 0.09, 3) > 0.45;
  }

  // The block one world column holds at height y (0 < y <= h). This is the
  // exact fill rule chunk() applies per cell, factored out so groundY can
  // scan a single column without generating the whole chunk (boot path:
  // spawn height used to cost two throwaway 16x64x16 chunk generations).
  function columnBlock(seed, wx, wz, y, h, surf) {
    var bs = B();
    if (y === 0) return bs.BEDROCK;
    var b;
    if (y === h) b = surf;
    else if (y >= h - 3 && surf !== bs.STONE) b = (surf === bs.SAND) ? bs.SAND : bs.DIRT;
    else b = bs.STONE;
    if (isCave(seed, wx, y, wz)) return bs.AIR;
    return b;
  }

  // Generate one chunk column into a fresh Uint8Array.
  function chunk(seed, cx, cz) {
    var a = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z);
    for (var lx = 0; lx < CHUNK_X; lx++) {
      for (var lz = 0; lz < CHUNK_Z; lz++) {
        var wx = cx * CHUNK_X + lx, wz = cz * CHUNK_Z + lz;
        var h = height(seed, wx, wz);
        var surf = surfaceBlock(seed, wx, wz, h);
        for (var y = 0; y <= h; y++) {
          a[index(lx, y, lz)] = columnBlock(seed, wx, wz, y, h, surf);
        }
      }
    }
    return a;
  }

  // Highest solid block y of a column (worldgen view — does not see player
  // edits). Analytical: scans the single column's fill rule from the
  // surface down — byte-identical to scanning a generated chunk, without
  // generating one.
  function groundY(seed, wx, wz) {
    var h = height(seed, wx, wz);
    var surf = surfaceBlock(seed, wx, wz, h);
    for (var y = h; y >= 1; y--) {
      if (columnBlock(seed, wx, wz, y, h, surf) !== 0) return y;
    }
    return 0; // fully carved column: the bedrock floor is the ground
  }

  return {
    CHUNK_X: CHUNK_X, CHUNK_Y: CHUNK_Y, CHUNK_Z: CHUNK_Z,
    index: index, chunk: chunk, height: height, groundY: groundY,
  };
})();
