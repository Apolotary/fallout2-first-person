"""Set pieces: the few big things that the artists painted across floor tiles and sprites.

Arroyo's stone head is a dome and a pillar as a sprite, and its face painted
on the floor tiles under them. The Temple of Trials is eight sprites of a
cliff, a gate and the tops of two towers, whose feet and steps are floor tiles
again. No outline says what such a thing is, so their shapes are written down
here (SHAPES), coarsely: an egg for the head, two beehives in front of a wall
for the temple. They are forms (render.js), textured by projection from the
game's camera out of one picture that this module composes of the floor tiles
and the sprites as the game paints them. So for that camera nothing changes,
and a walker meets a thing of stone instead of a card over a painted floor.

What the camera did not see is made up:

    round a turned shape (egg, beehive) only what is turned towards the camera
    shows what lies there; the rest of the way round, the same pixels run back
    again, drawn out. Towards its outline the picture shows such a shape at a
    grazing angle: a few ragged columns that would smear.
    the floor behind a turned shape, where its picture lies flat on the tiles,
    is covered with the ground that lies in front of it.
"""
import math

import numpy as np

from . import proj
from .forms import face

AROUND = 20             # faces round a turned shape
RINGS = 8               # ... and up a beehive
GRAZING = 0.12          # cosine of the angle between a surface and the camera's rays below which its pixels are a smear
MARGIN = 6              # px of picture kept around what the shapes show
REACH = 40              # hexes: the pieces of one picture are no further apart

# art name of the sprite a thing is found by: [shape]. Positions are (px right, px down) on
# the game's screen from that sprite's anchor (the hex centre) to a point on the floor.
#   ("turned", foot, [(height, radius), ...], crown)   a shape turned on a lathe: the foot of its axis, its profile in
#                                                units, and (optional) the band of its height that is plain material
#   ("wall", foot, axis, length, heights, lent)   an upright wall: one end of its foot, 'u' or 'v', units along +axis,
#                                                units up at either end, and the stretches that take their pixels elsewhere
# `with`: art names of the other sprites that are pieces of the same picture (they are hidden with it).
HIVE = lambda radius, height: [(height * n / RINGS, radius * math.sqrt(max(0.0, 1 - (n / RINGS) ** 2.2))) for n in range(RINGS + 1)]
SHAPES = {
    # Arroyo's stone head, and the spire of rock behind it that is part of its sprite.
    "head1.frm": {"with": (), "shapes": [("turned", (1, 43), [(0, 0.75), (0.3, 1.0), (0.8, 1.2), (1.3, 1.32), (1.8, 1.29), (2.2, 1.05),
                                                              (2.45, 0.65), (2.58, 0)], (0.72, 0.95)),
                                         ("turned", (-53, -27), [(0, 0.5), (0.8, 0.45), (1.6, 0.36), (2.1, 0.2), (2.25, 0)])]},
    # The Temple of Trials: the cliff with the gate as one wall, the two towers in front of it. Behind each
    # tower the wall shows cliff instead of the tower's picture.
    "temple01.frm": {"with": ("temple02.frm", "temple03.frm", "temple04.frm", "temple05.frm", "temple06.frm", "temple07.frm", "temple08.frm"),
                     "shapes": [("wall", (514, -168), "u", 15.3, (3.0, 6.65), [(2.3, 6.0, 0.1, 2.2), (10.2, 13.8, 13.9, 15.2)]),
                                ("turned", (-62, 30), HIVE(1.35, 5.25)),
                                ("turned", (316, -50), HIVE(1.35, 5.36))]},
}

RIGHT = np.array(proj.SCREEN_RIGHT) / math.hypot(*proj.SCREEN_RIGHT)       # ground direction to the right of the game's screen
NEAR = np.array(proj.TOWARD_CAMERA[:2]) / math.hypot(*proj.TOWARD_CAMERA[:2])     # ... and towards its camera


def turned(foot, profile, crown=None):
    """A shape turned round the upright axis over ground point `foot`: (faces, the floor it must not show).

    profile: [(height, radius)] from the bottom up. Angles are measured from the camera's
    line, to the right. The surface shows its own pixels where it is turned towards the camera
    by more than a grazing angle: on every ring that is an arc either side of the camera's line
    (all of the ring near the top of a dome, none of it under an overhang), and a face shows
    its own if all its corners lie in their arcs. Beyond the arc the pixels of the arc run back
    again, drawn out over the rest of the way round.
    crown: (from, to) as shares of the height, a band of plain material; what lies beyond the
    arc takes its pixels from there (a head has one face).
    """
    levels, ray = len(profile) - 1, np.array(proj.TOWARD_CAMERA)

    def at(angle, level):
        low = min(int(level), levels - 1)
        height, radius = np.array(profile[low]) + (np.array(profile[low + 1]) - profile[low]) * (level - low)
        return np.array([*(foot + radius * (math.sin(angle) * RIGHT + math.cos(angle) * NEAR)), height])

    def arc(level):
        """Half the angle of the arc of a ring that is turned towards the camera."""
        (h0, r0), (h1, r1) = profile[max(level - 1, 0)], profile[min(level + 1, levels)]
        out, up = np.array([h1 - h0, r0 - r1]) / math.hypot(h1 - h0, r0 - r1)      # the normal: outwards, upwards
        return math.acos(float(np.clip((GRAZING - up * ray[2]) / max(out * math.hypot(*ray[:2]), 1e-6), -1, 1)))

    def turn(angle):
        return (angle + math.pi) % (2 * math.pi) - math.pi

    def beyond(angle, level):
        """The point whose pixel a corner outside its ring's arc shows (or one of a face that has such a corner)."""
        angle, front = turn(angle), arc(level)
        round_ = max(0.0, abs(angle) - front) / max(math.pi - front, 1e-6)      # 0 at the end of the arc .. 1 right behind
        if crown:
            level = levels * (crown[0] + (crown[1] - crown[0]) * level / levels)
        return at(math.copysign(front * (1 - round_), angle), level)

    faces, heart = [], np.array([*foot, (profile[0][0] + profile[-1][0]) / 2])
    for ring in range(levels):
        for n in range(AROUND):
            a, b = 2 * math.pi * n / AROUND, 2 * math.pi * (n + 1) / AROUND
            corners = [(a, ring), (b, ring), (b, ring + 1), (a, ring + 1)]
            if profile[ring + 1][1] < 1e-6:                     # the top is a point
                corners.pop()
            elif profile[ring][1] < 1e-6:                       # ... or the bottom is
                corners.pop(0)
            points = [at(angle, level) for angle, level in corners]
            own = all(abs(turn(angle)) <= arc(level) + 1e-9 for angle, level in corners)
            faces.append(face(points, np.mean(points, axis=0) - heart, None if own else [beyond(angle, level) for angle, level in corners]))
    # Its picture lies flat on the floor wherever the camera's rays through it come down: the hull of those points.
    landed = [at(2 * math.pi * n / AROUND, ring) for ring in range(len(profile)) for n in range(AROUND)]
    return faces, [np.array([*point, 0.004]) for point in _hull([(p - ray * p[2] / ray[2])[:2] for p in landed])]


def _hull(points):
    """Convex hull of 2D points (Andrew's monotone chain), counter-clockwise."""
    points = sorted(map(tuple, points))
    turn = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    halves = []
    for run in (points, points[::-1]):
        half = []
        for point in run:
            while len(half) >= 2 and turn(half[-2], half[-1], point) <= 0:
                half.pop()
            half.append(point)
        halves.append(half[:-1])
    return [np.array(p) for p in halves[0] + halves[1]]


def wall(foot, axis, length, heights, lent=()):
    """An upright wall from ground point `foot` along +u or +v, seen from its camera side and from behind.

    heights: (at the foot, at the far end) in units. lent: [(start, end, from, to)] in units along
    the wall: the stretch start..end does not show its own pixels (they are the picture of
    something that stands in front of it) but those of the stretch from..to, as often as it takes.
    """
    step = np.array((1.0, 0, 0) if axis == "u" else (0, 1.0, 0))
    towards = np.array((0, 1.0, 0) if axis == "u" else (1.0, 0, 0))

    def quad(start, end):
        tall = lambda along: heights[0] + (heights[1] - heights[0]) * along / length
        a, b = np.array([*foot, 0.0]) + step * start, np.array([*foot, 0.0]) + step * end
        return [a, b, b + (0, 0, tall(end)), a + (0, 0, tall(start))]

    cuts = sorted({0.0, length} | {edge for start, end, _, _ in lent for edge in (start, end)})
    faces = []
    for start, end in zip(cuts, cuts[1:]):
        source = next(((a, b) for s, e, a, b in lent if s <= start and end <= e), None)
        pieces = [(start, end, None)]
        if source:                                              # in pieces as long as the source
            count = max(1, round((end - start) / abs(source[1] - source[0])))
            edges = np.linspace(start, end, count + 1)
            pieces = [(edges[n], edges[n + 1], source) for n in range(count)]
        for a, b, shows in pieces:
            corners, shown = quad(a, b), None
            if shows:
                shown = quad(*shows)
                for corner, own in zip(shown, corners):         # as tall as the piece itself, not as its source
                    corner[2] = own[2]
            faces += [face(corners, towards, shown), face(corners, -towards, shown)]
    return faces


def build(name, anchor, floor_rgba, sprites):
    """The form of the set piece found by the sprite `name` at world pixel `anchor` (its hex centre):
    -> (rgba, x, y, faces), or None if nothing is written down for it.

    floor_rgba(x0, y0, x1, y1)  the floor tiles of a rectangle of world pixels, as the game paints them
    sprites                     [(rgba, x, y)] of the thing's sprites, in the game's order
    """
    faces, patches = [], []
    ground = lambda offset: np.array(proj.px_to_ground(anchor[0] + offset[0], anchor[1] + offset[1]))
    for kind, foot, *rest in SHAPES[name]["shapes"]:
        if kind == "turned":
            made, patch = turned(ground(foot), *rest)
            patches.append(patch)
        else:
            made = wall(ground(foot), *rest)
        faces += made
    if not faces:
        return None
    # The picture: everything the faces show, and for every patch of floor the ground in front of it.
    depth = lambda patch: max((corner[:2] - patch[0][:2]) @ NEAR for corner in patch) - min((corner[:2] - patch[0][:2]) @ NEAR for corner in patch)
    lend = [np.array([*(NEAR * (depth(patch) + 0.3)), 0.0]) for patch in patches]
    for patch, shift in zip(patches, lend):
        faces.append(face(patch, (0, 0, 1), [corner + shift for corner in patch]))
    points = np.array([value for row in faces for value in (row[3] or row[2])]).reshape(-1, 3)
    px, py = proj.ground_to_px(points[:, 0], points[:, 1], points[:, 2])
    x0, y0, x1, y1 = int(px.min()) - MARGIN, int(py.min()) - MARGIN, int(px.max()) + MARGIN, int(py.max()) + MARGIN
    picture = floor_rgba(x0, y0, x1, y1)
    for rgba, x, y in sprites:
        ax, ay, bx, by = max(x, x0), max(y, y0), min(x + rgba.shape[1], x1), min(y + rgba.shape[0], y1)
        if ax < bx and ay < by:
            part = rgba[ay - y:by - y, ax - x:bx - x]
            picture[ay - y0:by - y0, ax - x0:bx - x0][part[..., 3] > 0] = part[part[..., 3] > 0]
    return picture, x0, y0, faces
