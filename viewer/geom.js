// The game's projection and hex grid, as used by the exporter (tools/fp/proj.py).
//
// World: (u, v) = floor-square coordinates, z = up, 1 unit = one square side.
// The engine's picture is the parallel projection
//     px(u, v, z) = origin + u * squ + v * sqv - (0, hpx * z)        (y down)
// All constants arrive in scene.proj; nothing here repeats their values.

export class Proj {
  constructor(p) {
    Object.assign(this, p);
    this.det = this.squ[0] * this.sqv[1] - this.sqv[0] * this.squ[1];
    this.roofZ = this.roofPx / this.hpx;
    this.groundPerPx = Math.hypot(...this.deltaToGround(0, 1));   // floor distance of one pixel down the screen
  }

  // Ground offset (du, dv) of a screen offset between two points on the floor.
  deltaToGround(dx, dy) {
    return [(this.sqv[1] * dx - this.sqv[0] * dy) / this.det,
            (this.squ[0] * dy - this.squ[1] * dx) / this.det];
  }

  pxToGround(x, y) {
    return this.deltaToGround(x - this.origin[0], y - this.origin[1]);
  }

  groundToPx(u, v, z = 0) {
    return [this.origin[0] + u * this.squ[0] + v * this.sqv[0],
            this.origin[1] + u * this.squ[1] + v * this.sqv[1] - this.hpx * z];
  }

  // Unit ground vector of a screen direction, e.g. (0, -1) = "north" = up the screen.
  groundDir(dx, dy) {
    const [u, v] = this.deltaToGround(dx, dy);
    const n = Math.hypot(u, v);
    return [u / n, v / n];
  }

  // Direction towards the game's camera: the line of points that share a pixel.
  towardCamera() {
    const k = [this.sqv[0], -this.squ[0], 0];
    k[2] = (k[0] * this.squ[1] + k[1] * this.sqv[1]) / this.hpx;
    const n = Math.hypot(k[0], k[1], k[2]);
    return k.map((c) => c / n);
  }
}

// How a camera-facing sprite stands in the world (the same rule as card() in
// tools/fp/proj.py). sprite = [page, x, y, w, h, ox, oy] with (ox, oy) = its
// top-left pixel relative to the anchor (the hex centre).
//
// A sprite shows its object from 27 degrees above, so the rows below the hex
// centre are floor in front of the object, not something hanging under it. The
// card therefore runs from the floor point under its lowest row up to its top
// row above the anchor: a person (a few pixels below the centre) stands almost
// upright, a bed (far below) leans back over its footprint, and what ends above
// the centre (a wall cabinet) hangs upright over the anchor. From the game's
// camera all of these project to the same pixels.
//   shift   pixels down the screen from the anchor to the middle of the card's footprint
//   lean    half the footprint depth: the bottom edge comes this far towards the viewer
//   z0, z1  height of the bottom and top edge
// This is where the game's views draw a card; what it hides is decided by its hex
// (rowPlane). First person has no fixed side to lean away from: there the card
// stands upright on the middle of its footprint, from up0 to up1. The rows that
// showed the footprint (floor seen from above) come to stand too and would make
// a person taller, so they count FOOT of their height.
const FOOT = 0.5;
export function card(proj, sprite) {
  const top = sprite[6], bottom = top + sprite[4];
  if (bottom <= 0) {
    const z0 = -bottom / proj.hpx, z1 = -top / proj.hpx;
    return { shift: 0, lean: 0, z0, z1, up0: z0, up1: z1 };
  }
  const far = Math.min(bottom, Math.max(0, top));
  return { shift: (bottom + far) / 2, lean: (bottom - far) / 2 * proj.groundPerPx, z0: 0, z1: (far - top) / proj.hpx,
           up0: 0, up1: (far - top + FOOT * (bottom - far)) / proj.hpx };
}

// ---------------------------------------------------------------- hex grid
// 200 x 200 hexes, tile = hy * 200 + hx (tile.cc; f2lib.geometry is the reference).
export const HEX_W = 200;
// Screen step of the hex centre per facing 0..5 = NE, E, SE, SW, W, NW.
export const DIR_PIXELS = [[16, -12], [32, 0], [16, 12], [-16, 12], [-32, 0], [-16, -12]];

// Continuous world pixel of a hex centre (middle of its 32x16 cell).
export function hexPx(tile) {
  const hx = tile % HEX_W, hy = Math.floor(tile / HEX_W);
  const a = HEX_W - 1 - hx;
  return [48 * (a >> 1) + 32 * (a & 1) + 16 * hy + 16, -12 * (a >> 1) + 12 * hy + 8];
}

// Corner cut-outs of the 32x16 hex cell (tileInit's _tile_mask): 1 / 2 = the
// pixel belongs to the upper-left / upper-right neighbour.
const MASK = (() => {
  const mask = new Uint8Array(32 * 12);
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 16; i++) {
      if (64 - 4 * i > 16 * row) mask[32 * row + i] = 1;
      if (4 * i > 16 * row) mask[32 * row + 16 + i] = 2;
    }
  }
  return mask;
})();

// Tile whose hexagon contains world pixel (x, y), or -1 (tileFromScreenXY).
export function hexFromPx(x, y) {
  x = Math.floor(x); y = Math.floor(y);
  const v3 = Math.floor(y / 12);
  const v4 = x - 16 * v3;
  const v5 = y - 12 * v3;
  const v6 = Math.floor(v4 / 64);
  let v10 = v6 + v3;
  let v8 = v4 - v6 * 64;
  let v11 = 2 * v6;
  if (v8 >= 32) { v8 -= 32; v11 += 1; }
  const corner = MASK[32 * v5 + v8];
  if (corner === 2) {
    v11 += 1;
    if (v11 & 1) v10 -= 1;
  } else if (corner === 1) {
    v10 -= 1;
  }
  const hx = HEX_W - 1 - v11;
  return hx >= 0 && hx < HEX_W && v10 >= 0 && v10 < HEX_W ? v10 * HEX_W + hx : -1;
}

// The depth at which whatever stands on a hex is sorted (row_plane() in
// tools/fp/proj.py): v of an upright plane along u. The game paints hex rows
// back to front and each row from screen right to left; as geometry, all
// sprites of a row lie in one plane (the line of its even hexes), tilted by a
// hair so that the later hex is nearer. stack = how many sprites the game
// paints on the same hex before this one.
export function rowPlane(proj, u, v, stack = 0) {
  const tile = hexFromPx(...proj.groundToPx(u, v));
  if (tile < 0) return v;
  const hx = tile % HEX_W;
  const nudge = proj.rowTilt * hx + proj.stack * Math.min(stack, proj.rowTilt / proj.stack - 1);
  return proj.pxToGround(...hexPx(tile - (hx & 1)))[1] + nudge;
}
