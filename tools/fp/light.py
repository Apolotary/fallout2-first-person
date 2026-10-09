"""Baked light for the first-person view: one RGB image over the whole floor.

    R  lamp light, 0..1   the map's light emitters, engine falloff, stopped by walls
    G  daylight, 0..1     1 under the open sky, fading to 0 within DAYLIGHT_REACH of
                          walking distance under a roof (so it reaches under eaves but
                          not through walls), and a pool of it inside every outer door
    B  floor shade, 1..0  contact shadow along wall bases and a blob under every sprite card

Texel (i, j) covers ground [i, i + 1) x [j, j + 1) / RES; the viewer samples it
with the world position of each fragment (walls: a little in front of their
face, cards: at their anchor). The game itself only has the first channel, per
hex (research/04 section 13); the other two exist because a first-person view
without any shading reads as flat cardboard.
"""
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from f2lib import map as mapfile

from . import proj

RES = 8                     # texels per world unit
SIZE = 100 * RES
HEX_STEP = 0.54             # world units between neighbouring hex centres (0.5 .. 0.56 by direction)
DAYLIGHT_REACH = 1.6        # units of walking distance that daylight gets in under a roof
DOOR_OPEN = 0.3             # a door that gets this much daylight is one to the outside
DOOR_LIGHT, DOOR_REACH = 0.9, 2.4       # the daylight in such a doorway, and how far it goes on into the room
WALL_SHADE, WALL_REACH = 0.42, 0.4      # darkest floor shade at a wall base, and how far it reaches (units)
BLOB_SHADE = 0.38
INTENSITY_MAX = 65536.0     # light.h
INTENSITY_FLOOR = 655.0     # the engine's per-hex reset value (light.cc)
SHADOW_INDEX = 207          # the palette's near-black (12, 12, 12): what cast shadows are painted with
DARK_INDICES = (SHADOW_INDEX, 100)  # ... and its other one, (4, 12, 0)
SHADOW_NEAR = 14            # px above the hex centre: up to here a shadow may start, and run under its object
SHADOW_REACH = 48           # px above the hex centre: no painted shadow goes further up the screen
SHADOW_MIN = 12             # px: fewer are specks of outline, not a shadow
SHADOW_SPARSE = 0.45        # a sprite filling less of its rectangle than this is a plant or a pole:
                            # its shadow shows between its leaves, not only beside it


def emitters(objects):
    """[(u, v, reach in units, power 0..1)] of the objects that light their surroundings.

    _obj_adjust_light: only with the LIGHTING flag; a hex at ring distance d gets
    intensity - d * (intensity - 655) / (distance + 1), i.e. nothing from ring distance + 1 on.
    """
    lights = []
    for obj in objects:
        if obj.light_intensity <= 0 or not obj.flags & mapfile.OBJECT_LIGHTING:
            continue
        u, v = proj.px_to_ground(*proj.hex_px(obj.tile))
        power = min(obj.light_intensity, INTENSITY_MAX)
        reach = (min(obj.light_distance, 8) + 1) * HEX_STEP * power / (power - INTENSITY_FLOOR)
        lights.append((u, v, reach, power / INTENSITY_MAX))
    return lights


def _window(u0, v0, u1, v1, res):
    """Texel index ranges covering a ground rectangle, and the ground coordinates of their centres."""
    size = 100 * res
    i0, i1 = max(0, int(u0 * res)), min(size, int(math.ceil(u1 * res)))
    j0, j1 = max(0, int(v0 * res)), min(size, int(math.ceil(v1 * res)))
    gu, gv = np.meshgrid((np.arange(i0, i1) + 0.5) / res, (np.arange(j0, j1) + 0.5) / res)
    return (slice(j0, j1), slice(i0, i1)), gu, gv


def _distance(gu, gv, a, b):
    """Distance of ground points from segment a-b."""
    du, dv = b[0] - a[0], b[1] - a[1]
    t = np.clip(((gu - a[0]) * du + (gv - a[1]) * dv) / max(du * du + dv * dv, 1e-9), 0, 1)
    return np.hypot(gu - a[0] - du * t, gv - a[1] - dv * t)


def lamps(lights, segments, res=RES // 2):
    """Sum of all emitters at every texel; a wall between lamp and texel stops the light."""
    size = 100 * res
    out = np.zeros((size, size), np.float32)
    seg = np.asarray(segments, np.float32).reshape(-1, 4)
    for u, v, reach, power in lights:
        window, gu, gv = _window(u - reach, v - reach, u + reach, v + reach, res)
        if not gu.size:
            continue
        ru, rv = gu.ravel() - u, gv.ravel() - v                 # ray from the lamp to each texel
        level = power * np.clip(1 - np.hypot(ru, rv) / reach, 0, 1)
        near = seg[(np.minimum(seg[:, 0], seg[:, 2]) < u + reach) & (np.maximum(seg[:, 0], seg[:, 2]) > u - reach)
                   & (np.minimum(seg[:, 1], seg[:, 3]) < v + reach) & (np.maximum(seg[:, 1], seg[:, 3]) > v - reach)]
        if len(near):
            au, av = near[:, 0] - u, near[:, 1] - v
            su, sv = near[:, 2] - near[:, 0], near[:, 3] - near[:, 1]
            denom = ru[:, None] * sv - rv[:, None] * su         # ray x segment
            denom[np.abs(denom) < 1e-9] = 1e-9
            t = (au * sv - av * su) / denom                     # along the ray, 0 = lamp, 1 = texel
            w = (au * rv[:, None] - av * ru[:, None]) / denom   # along the segment
            # A lamp that hangs on a wall shines to both sides: the first 0.2 units of a ray hit nothing.
            first = 0.2 / np.maximum(np.hypot(ru, rv), 1e-6)
            hit = (t > first[:, None]) & (t < 0.97) & (w >= 0) & (w <= 1)
            level[hit.any(axis=1)] = 0
        out[window] += level.reshape(gu.shape)
    image = Image.fromarray(np.uint8(np.minimum(out, 1) * 255)).resize((SIZE, SIZE), Image.BILINEAR)
    return np.asarray(image.filter(ImageFilter.GaussianBlur(1.5)), np.float32) / 255


def _spread(lit, free, reach):
    """Light that walks from the `lit` texels through the `free` ones: 1 there, fading to 0 after `reach` units."""
    reached = lit.copy()
    level = reached.astype(np.float32)
    steps = int(reach * RES)
    for step in range(1, steps + 1):                            # one texel further in every round
        grown = reached.copy()
        grown[1:] |= reached[:-1]
        grown[:-1] |= reached[1:]
        grown[:, 1:] |= reached[:, :-1]
        grown[:, :-1] |= reached[:, 1:]
        new = grown & free & ~reached
        level[new] = 1 - step / (steps + 1)
        reached |= new
    return level


def daylight(roof, barriers, doors):
    """roof: 100x100 bool. Open ground is 1; under a roof the light fades with the walking distance from open ground.

    A door that this light reaches lets it in as if it stood open (it does when one walks up to it):
    from the doorway a pool of DOOR_LIGHT spreads DOOR_REACH into the room.
    """
    roofed = np.kron(roof, np.ones((RES, RES), bool))
    wall = Image.new("L", (SIZE, SIZE), 0)
    draw = ImageDraw.Draw(wall)
    for ua, va, ub, vb in barriers:
        draw.line([(ua * RES, va * RES), (ub * RES, vb * RES)], fill=255, width=2)
    free = roofed & (np.asarray(wall) == 0)
    level = _spread(~roofed, free, DAYLIGHT_REACH)
    doorways = Image.new("L", (SIZE, SIZE), 0)
    draw = ImageDraw.Draw(doorways)
    for ua, va, ub, vb in doors:
        j, i = int((va + vb) / 2 * RES), int((ua + ub) / 2 * RES)
        if level[max(j - 3, 0):j + 4, max(i - 3, 0):i + 4].max(initial=0) > DOOR_OPEN:
            draw.line([(ua * RES, va * RES), (ub * RES, vb * RES)], fill=255, width=3)
    lit = (np.asarray(doorways) > 0) & free
    level = np.maximum(level, DOOR_LIGHT * _spread(lit, free, DOOR_REACH))
    return np.asarray(Image.fromarray(np.uint8(level * 255)).filter(ImageFilter.GaussianBlur(1)), np.float32) / 255


def _grown(mask):
    """mask plus every pixel next to it (8 neighbours)."""
    padded = np.pad(mask, 1)
    h, w = mask.shape
    return np.any([padded[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)], axis=0)


def painted_shadow(index, top):
    """Which pixels of a sprite are the shadow its artist painted on the floor beside the object?

    index: the frame's palette indices; top: screen row of its first row relative
    to the hex centre. -> bool mask, or None. On an upright card such a shadow
    would stand up like a black flag, so first person lays it on the floor
    instead (scene.py, add_card). It is recognised as a patch of SHADOW_INDEX that

        starts near the floor and beside the object (left or right of all the
        other pixels of its row),
        is more than a line thick (outlines are drawn in the same colour), and
        from there runs up the screen, at most SHADOW_REACH, staying beside the
        object - or under it near the floor (the dark under a cart), or anywhere
        behind something as airy as a corn plant.
    """
    dark = index == SHADOW_INDEX
    body = (index != 0) & ~dark
    columns = np.arange(index.shape[1])
    first = np.where(body.any(axis=1), body.argmax(axis=1), index.shape[1])
    last = np.where(body.any(axis=1), index.shape[1] - 1 - body[:, ::-1].argmax(axis=1), -1)
    beside = (columns < first[:, None]) | (columns > last[:, None])
    above = -(top + np.arange(index.shape[0]))[:, None]         # px above the hex centre, per row
    padded = np.pad(dark, 1).astype(np.uint8)
    h, w = dark.shape
    thick = dark & (sum(padded[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)) >= 4)
    sparse = body.sum() < SHADOW_SPARSE * index.size
    where = (beside | (above <= SHADOW_NEAR) | sparse) & (above <= SHADOW_REACH)
    patch = thick & beside & (above <= SHADOW_NEAR)
    while True:
        more = _grown(patch) & thick & where
        if (more == patch).all():
            break
        patch = more
    mask = _grown(patch) & dark & where
    return mask if mask.sum() >= SHADOW_MIN else None


def outer_dark(index):
    """The near-black pixels of a sprite that lie open to its surroundings: bool mask.

    Artists painted the floor in an object's shadow with the palette's two
    near-blacks: beside the object, under a table, under a bed. Such a patch
    is more than a line thick (outlines have the same colours) and can be
    walked from the sprite's transparent surroundings without leaving the
    black. Black that is shut in by the object - the gaps of a shelf, a
    window - is the object's own. props.py reads an object's size from what
    is left, and first person shows these patches lying on the floor.
    """
    dark = np.isin(index, DARK_INDICES)
    padded = np.pad(dark, 1).astype(np.uint8)
    h, w = dark.shape
    thick = dark & (sum(padded[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)) >= 4)
    reached = np.pad(index == 0, 1, constant_values=True)
    while True:
        more = reached | (_grown(reached) & np.pad(thick, 1))
        if (more == reached).all():
            break
        reached = more
    return _grown(reached[1:-1, 1:-1] & thick) & dark


def blob(alpha, left, top, u, v):
    """Soft shadow under a sprite card anchored at ground (u, v): (centre u, v, half width, half depth).

    alpha: the sprite's opaque pixels, (left, top) its top-left pixel relative to the
    anchor. The card stands on the footprint described in proj.card; its lowest rows
    are where it touches the floor, so their width is the width of the shadow.
    """
    rows = np.nonzero(alpha.any(axis=1))[0]
    if not len(rows):
        return None
    bottom = top + rows[-1] + 1
    if bottom <= 0:                                             # hangs on a wall: no shadow
        return None
    foot = alpha[max(rows[0], rows[-1] - max(4, len(rows) // 8)):rows[-1] + 1].any(axis=0)
    columns = np.nonzero(foot)[0]
    far = min(bottom, max(0, top + rows[0]))
    du, dv = proj.delta_to_ground(left + (columns[0] + columns[-1] + 1) / 2, (bottom + far) / 2)
    half_width = min(max((columns[-1] - columns[0] + 1) / 2 / proj.BB_PX * 1.15, 0.14), 0.9)
    half_depth = min(max((bottom - far) / 2 * math.hypot(*proj.delta_to_ground(0, 1)), half_width * 0.45), 0.6)
    return u + du, v + dv, half_width, half_depth


def floor_shade(segments, blobs):
    """1 = unshaded. The darkest of: every wall base's contact shadow, every blob."""
    shade = np.zeros((SIZE, SIZE), np.float32)
    for ua, va, ub, vb in segments:
        window, gu, gv = _window(min(ua, ub) - WALL_REACH, min(va, vb) - WALL_REACH,
                                 max(ua, ub) + WALL_REACH, max(va, vb) + WALL_REACH, RES)
        if gu.size:
            near = np.clip(1 - _distance(gu, gv, (ua, va), (ub, vb)) / WALL_REACH, 0, 1)
            shade[window] = np.maximum(shade[window], WALL_SHADE * near * near)
    right = np.array(proj.SCREEN_RIGHT) / math.hypot(*proj.SCREEN_RIGHT)
    for cu, cv, half_width, half_depth in blobs:
        reach = max(half_width, half_depth)
        window, gu, gv = _window(cu - reach, cv - reach, cu + reach, cv + reach, RES)
        if gu.size:
            across = (gu - cu) * right[0] + (gv - cv) * right[1]
            along = -(gu - cu) * right[1] + (gv - cv) * right[0]
            near = np.clip(1 - np.hypot(across / half_width, along / half_depth), 0, 1)
            shade[window] = np.maximum(shade[window], BLOB_SHADE * near * near * (3 - 2 * near))
    return 1 - shade


def bake(lights, light_stops, roof, barriers, doors, shade_segments, blobs, indoor):
    """-> (SIZE, SIZE, 3) uint8, see the module docstring.

    light_stops / barriers / shade_segments: [ua, va, ub, vb] ground segments that
    stop lamp light / stop daylight under roofs / throw a contact shadow; doors: where they hang.
    """
    sun = np.zeros((SIZE, SIZE), np.float32) if indoor else daylight(roof, barriers, doors)
    channels = [lamps(lights, light_stops), sun, floor_shade(shade_segments, blobs)]
    return np.uint8(np.clip(np.dstack(channels), 0, 1) * 255 + 0.5)
