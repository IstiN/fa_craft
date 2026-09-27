// Voxel raycast (Amanatides & Woo DDA) for block targeting.
var Facraft = Facraft || {};
Facraft.raycast = {
  // Returns {hit:true, x,y,z (block), nx,ny,nz (entry face normal),
  // px,py,pz (adjacent placement cell)} or {hit:false}.
  pick: function(world, ox, oy, oz, dx, dy, dz, maxDist) {
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len === 0) return { hit: false };
    dx /= len; dy /= len; dz /= len;

    var x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    var solid = function(bx, by, bz) {
      return Facraft.blocks.isSolid(Facraft.world.get(world, bx, by, bz));
    };

    if (solid(x, y, z)) {
      return { hit: true, x: x, y: y, z: z, nx: 0, ny: 0, nz: 0, px: x, py: y, pz: z };
    }

    var stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    var tMaxX = dx !== 0 ? ((dx > 0 ? x + 1 - ox : ox - x) / Math.abs(dx)) : Infinity;
    var tMaxY = dy !== 0 ? ((dy > 0 ? y + 1 - oy : oy - y) / Math.abs(dy)) : Infinity;
    var tMaxZ = dz !== 0 ? ((dz > 0 ? z + 1 - oz : oz - z) / Math.abs(dz)) : Infinity;
    var tDeltaX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
    var tDeltaY = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
    var tDeltaZ = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
    var nx = 0, ny = 0, nz = 0;
    var t = 0;

    while (t <= maxDist) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) break;
      if (solid(x, y, z)) {
        return {
          hit: true, x: x, y: y, z: z, nx: nx, ny: ny, nz: nz,
          px: x + nx, py: y + ny, pz: z + nz,
        };
      }
    }
    return { hit: false };
  },
};
