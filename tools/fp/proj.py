"""The game's projection, named once; everything else in the exporter derives from it.

World: floor squares are unit squares. (u, v) = (square x, square y), z = up,
1 unit = one square side = two hexes. (u, v, z) is right-handed.

The engine draws a parallel projection that is fully described by where the two
square steps land on screen (tile.cc, research/04 section 11.2) plus the fact
that "up" stays vertical:

    px(u, v, z) = ORIGIN + u * SQ_U + v * SQ_V - (0, HPX * z)          (y down)

ORIGIN is the top vertex of square 0's rhombus in f2lib.geometry "world pixels"
(square_world(0) + (48, 0)); pixel index p covers [p, p + 1).

SQ_U and SQ_V are not quite what an orthographic camera would produce for
perpendicular unit vectors (after undoing the foreshortening they are 82.9 deg
apart, not 90), so there is no exact azimuth / elevation. The closest camera
has scale s = |(SQ_U.x, SQ_V.x)| = 57.7 px per unit and
sin(elevation) = |(SQ_U.y, SQ_V.y)| / s, i.e. elevation 27.7 deg; a vertical
unit is then s * cos(elevation) = sqrt(57.7^2 - 26.8^2) = 51.07 px. That number
(HPX) is the only fitted constant: iso mode in the viewer uses the affine map
above verbatim, which is why it reproduces the game's picture pixel for pixel.
"""
import math

from f2lib import geometry

SQ_U = (-48.0, 12.0)            # screen step of +1 square x
SQ_V = (32.0, 24.0)             # screen step of +1 square y
ORIGIN = (4784.0, -1190.0)      # world pixel of ground point (0, 0)
HPX = math.sqrt(SQ_U[0] ** 2 + SQ_V[0] ** 2 - SQ_U[1] ** 2 - SQ_V[1] ** 2)   # px per unit of height
ROOF_PX = float(geometry.ROOF_HEIGHT)                                        # roofs: 96 px up = 1.88 units

# Ground direction that runs horizontally on screen: a camera-facing sprite is
# BB_PX pixels wide per world unit.
_DET = SQ_U[0] * SQ_V[1] - SQ_V[0] * SQ_U[1]
SCREEN_RIGHT = (SQ_V[1] / _DET, -SQ_U[1] / _DET)        # ground vector that moves 1 px right
BB_PX = 1.0 / math.hypot(*SCREEN_RIGHT)                 # 57.24

U_SLOPE = SQ_U[1] / SQ_U[0]     # screen slope of a line along u: -1/4
V_SLOPE = SQ_V[1] / SQ_V[0]     # screen slope of a line along v: +3/4

# The line of points that share a pixel: moving along it changes nothing on the game's screen.
_RAY = (SQ_V[0], -SQ_U[0], (SQ_V[0] * SQ_U[1] - SQ_U[0] * SQ_V[1]) / HPX)
TOWARD_CAMERA = tuple(c / math.sqrt(sum(c * c for c in _RAY)) for c in _RAY)    # unit vector (u, v, z)


def delta_to_ground(dx, dy):
    """Ground (du, dv) of a screen offset between two points on the floor."""
    return (SQ_V[1] * dx - SQ_V[0] * dy) / _DET, (SQ_U[0] * dy - SQ_U[1] * dx) / _DET


def px_to_ground(x, y):
    """World pixel (continuous) -> ground point (u, v) at z = 0."""
    return delta_to_ground(x - ORIGIN[0], y - ORIGIN[1])


def ground_to_px(u, v, z=0.0):
    return (ORIGIN[0] + u * SQ_U[0] + v * SQ_V[0],
            ORIGIN[1] + u * SQ_U[1] + v * SQ_V[1] - HPX * z)


def hex_px(tile):
    """Continuous world pixel of a hex centre (the middle of its 32x16 cell)."""
    x, y = geometry.hex_world(tile)
    return x + 16.0, y + 8.0


def card(top, bottom):
    """How a camera-facing sprite stands (the same rule as card() in viewer/geom.js).

    top / bottom: first row and one past the last row of the sprite, px below the
    anchor (the hex centre). A sprite shows its object from 27 degrees above, so
    rows below the anchor are floor in front of the object rather than something
    hanging under it. The card runs from the floor point under its lowest row
    (height 0) to its top row above the anchor: a person stands almost upright, a
    bed leans back over its footprint. A sprite that ends above the anchor hangs
    upright over it.
    -> (z0, z1): heights of the bottom and the top edge.

    That is where the game's views draw a card (first person stands it upright
    on the middle of that footprint). What it hides and is hidden by is decided
    elsewhere: by its hex, like the game does (row_plane).
    """
    if bottom <= 0:
        return -bottom / HPX, -top / HPX
    return 0.0, (min(bottom, max(0, top)) - top) / HPX


ROW_TILT = 5e-4     # units of depth per hex along a row: enough to order neighbours, 0.1 over a whole row
STACK = 1e-4        # units of depth between sprites on one hex (at most ROW_TILT / STACK of them are told apart)


def row_plane(tile, stack=0):
    """The depth at which whatever stands on a hex is sorted: v of an upright plane along u.

    The game paints hex rows back to front and each row from screen right to
    left, whatever the size of the sprites. As geometry: all cards of one hex row
    lie in one vertical plane along u (hexes zigzag by a quarter unit around
    their row; the even ones give the line), tilted by a hair so that the later
    hex is nearer. Planes of different rows are parallel, half a unit apart, and
    wall faces along u stand between them, so cards sort against each other and
    against walls exactly as in the game - except a sprite on the hex row of a
    wall itself, which things.py turns into a sheet on that wall.
    stack: how many cards the game paints on this hex before this one.
    """
    hx, hy = geometry.tile_xy(tile)
    nudge = ROW_TILT * hx + STACK * min(stack, ROW_TILT / STACK - 1)
    return px_to_ground(*hex_px(geometry.tile_at(hx & ~1, hy)))[1] + nudge


def plane_floor_y(v, x):
    """World pixel y of the floor line of the plane v = const at world pixel x."""
    u = (ORIGIN[0] + v * SQ_V[0] - x) / -SQ_U[0]
    return ORIGIN[1] + u * SQ_U[1] + v * SQ_V[1]


def as_json():
    return {"squ": SQ_U, "sqv": SQ_V, "origin": ORIGIN, "hpx": round(HPX, 5),
            "roofPx": ROOF_PX, "bbPx": round(BB_PX, 5), "rowTilt": ROW_TILT, "stack": STACK}
