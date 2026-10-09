"""Wall faces -> solid walls: thickness, a top, a far side, ends.

walls.py leaves every wall as its picture on one upright plane, the side of the
wall the game's camera looks at (the "front": it faces +v for a wall along u,
+u for one along v). The wall itself is a slab behind that plane, and its
picture shows three of the slab's faces, all of them seen by one camera:

    the front           what stands on the plane up to the wall's height
    the top             the rows above that height. They are not higher wall:
                        they are the slab's top face, as deep as the slab is
                        thick, seen from above. The viewer lays them back
                        (viewer/render.js: every texel goes to the point
                        where the camera's ray through it meets the wall's
                        height, so the game's camera still sees each pixel
                        where it was)
    an end, sometimes   left on the front plane, or folded round the corner (walls.fold_ends)

So the picture itself says how thick a wall is: one unit of depth behind the
plane is `depth_px` rows of top face (32 for a wall along u, 48 along v). Walls
are as tall as roofs are high (proj.ROOF_PX), except those the artists drew cut
open at shoulder height to show the room behind (Vault City's adobe): their top
face is the black of the section, and they end where it begins. A run of wall
pieces gets one thickness, the median of what clean pieces show in all runs of
its kit (the runs along the same axis whose top faces are about equally tall).

What the camera never saw has to be made up:

    the back    the far side of the slab, the same outline as the front (so
                windows and doorways stay open). Its material depends on what
                is on either side. The game shows the far walls of a room from
                indoors and the near walls from outdoors, so a building's kit
                holds both materials: where a wall stands between indoors and
                outdoors (_sides), its back takes the picture of the nearest
                plain piece of the same building that the camera sees from that
                side, in the wall's own outline. A piece
                with a window takes the nearest such window instead, and one that
                shows something (a painted window, an ornament, a door's casing)
                keeps its picture. Walls with the same on both sides -
                partitions, fences, ruins - show their own picture on both.
    ends        a strip of the nearest plain piece, as wide as the wall is thick,
                wherever a solid stretch of wall stops without another wall to
                close it: free ends and the two sides of every doorway.
    bridges     where another wall ends at a wall's front, the block the two
                share has a back that no picture shows (the outer corner of two
                far walls; the gap a crossing wall leaves beside a corner
                post): the back is drawn on across it, again with a strip.
    the rest of a wall drawn cut open, up to the roofs: on front, back and ends
                the material of a plain piece goes on above the cut, mirrored
                there (first person only: the game's camera sees the section).

`thicken` works all of this out; collisions follow the same slabs (`boxes`),
less the width of every door that hangs in one.
"""
from collections import Counter

import numpy as np

from . import proj, walls

MAX_BAND = 30           # px: more rows than this above the wall's height are not a top face (taller walls)
MIN_BAND = -3           # px: a wall may end this far under roof height and still be a full wall
CLEAN = 0.7             # share of a piece's columns that must reach its upper edge for its top to count
THIN = 0.06             # units: fences, ruins, whatever shows no top face
THICKNESS = (0.05, 0.4)     # units: what a measured thickness is limited to
SAME_KIT = 1.5          # px: runs whose top faces differ by less are of one kit
SECTION = 8             # rows of black, at least, where a wall is drawn cut open ...
SECTION_START = 12      # ... beginning within this many rows of its upper edge ...
SECTION_UNDER = 8       # ... and ending this far under roof height at least (px)
BLACK = 16              # colour levels: darker is black
SHADE = 0.75            # rows under the band that are darker than this share of the wall below belong to the section
MIN_SOLID = 0.1         # units: thinner walls get no ends and the same picture on both sides
INDOORS = 1.5           # units of roof beyond a face: more is a room, less is eaves
OUTSIDE = 4             # a picture seen this many times more often from outdoors than from indoors is an outside
ROOF_START, ROOF_REACH, ROOF_STEP = 0.6, 3.0, 0.125
PLAIN = 0.9             # share of opaque pixels of a piece without openings (its neighbours may cut notches)
FIGURE, FIGURE_LEVELS = 3.0, 10     # a piece this many times further from its wall's usual colours than the
                                    # usual piece, and this many colour levels at least, shows something
WINDOW = 6              # px shut in by wall: a window
EDGE_ROWS = 4           # a piece with fewer than 4 times as many rows is too low to tell
MIN_WIDTH = 6           # px: narrower pieces do not lend their material
JOIN = 0.03             # units: ends this close are the same place
CRACK = 0.12            # units: a gap this narrow between two pieces is a crack in the art, not an opening
REACH = 0.45            # units: a wall "ends at" a crossing wall within this distance (walls.FOLD_REACH)
COVER = 0.06            # units: an end this deep inside (or this close to) another slab is not drawn


def depth_px(along_u):
    """Rows of un-sheared picture per unit of depth behind a face's plane (compare Face.move_to)."""
    ox, oy = proj.SQ_V if along_u else proj.SQ_U
    return oy - (proj.U_SLOPE if along_u else proj.V_SLOPE) * ox


class Cut:
    """One wall face as exported: its un-sheared picture and where that stands.

    a, b     ground points under the picture's left and right edge. Seen from the
             front a is on the left; every upright quad of the scene is given so.
    top      px above the floor line of the picture's upper edge
    cap      rows of top face; zc = the height where they start
    section  the rows of the section of a wall drawn cut open (_section), else 0
    kind     what the picture under the cap line is: 'plain' (a wall without an
             opening, give or take a notch), 'window' (holes shut in by wall,
             nothing to walk through), 'figure' (it shows something that is not
             wall: _figures) or 'other' (doorways, ruins, posts);
             lends = it is whole and wide enough to give others its material
    sides    is there a room in front of it, behind it? (_sides)
    back     sprite of the far side (-1: the picture itself)
    above    sprites that go on above zc in first person, on the front and on the back (-1: none)
    """

    def __init__(self, face, sprite, image, x0, x1, y_top):
        self.face, self.sprite, self.image, self.x0 = face, sprite, image, x0
        self.a, self.b = face.ends(x0, x1)
        self.top = face.c - y_top
        self.rows, self.width = image.shape[:2]
        self.z0, self.z1 = (self.top - self.rows) / proj.HPX, self.top / proj.HPX
        self.cap, self.thick, self.kind, self.lends, self.sides = 0, 0.0, "other", False, (False, False)
        self.back, self.above, self.donor, self.building = -1, [-1, -1], None, 0
        self.solid = walls.solid_runs(image, self.z0) if face.kind == "wall" else []
        alpha = image[..., 3] > 0
        self.clean = bool(alpha.any() and alpha[:2][:, alpha.any(axis=0)].any(axis=0).mean() >= CLEAN)   # a level top
        self.section = _section(image, alpha) if face.kind == "wall" else 0
        if self.top - self.section > proj.ROOF_PX - SECTION_UNDER:
            self.section = 0

    @property
    def zc(self):
        return (self.top - self.cap) / proj.HPX

    def at(self, column):
        """Ground point of the front plane under a column of the picture."""
        return self.face.ends(self.x0 + column, self.x0)[0]

    def body(self):
        """(opaque pixels under the cap line, first and one past the last opaque column)."""
        alpha = self.image[self.cap:, :, 3] > 0
        columns = np.flatnonzero(alpha.any(axis=0))
        return (alpha, int(columns[0]), int(columns[-1]) + 1) if len(columns) else (alpha, 0, 0)

    def sort(self):
        """Set kind and lends."""
        alpha, c0, c1 = self.body()
        box = alpha[:-2, c0:c1]                     # the lowest rows follow the pixel stairs of the floor line
        closed = len(self.solid) == 1 and self.solid[0][0] <= c0 + 2 and self.solid[0][1] >= c1 - 2
        if closed and len(box) >= 4 * EDGE_ROWS:
            if _shut_in(box).sum() >= WINDOW:
                self.kind = "window"
            elif box.mean() >= PLAIN:
                self.kind, self.lends = "plain", bool(box.all() and c1 - c0 >= MIN_WIDTH)

    def material(self, rows, width, first=0):
        """`width` columns of the picture's rows (counted from the cap line; above it they are
        mirrored there), its columns from `first` on repeated along the wall."""
        _, c0, c1 = self.body()
        rows = self.cap + np.where(rows < 0, -1 - rows, rows)
        return self.image[np.clip(rows, self.cap, self.rows - 3)][:, c0 + (np.arange(width) - first) % max(c1 - c0, 1)]


def _section(image, alpha):
    """Where a wall is drawn cut open: the rows down to the end of the black band of its section
    and of the shade under that band; 0 if there is none."""
    level = (image[..., :3].max(axis=2) * alpha).sum(axis=1) / np.maximum(alpha.sum(axis=1), 1)
    black = (alpha & (image[..., :3].max(axis=2) > BLACK)).sum(axis=1) <= 0.1 * alpha.sum(axis=1)
    black &= alpha.sum(axis=1) >= 0.8 * alpha.any(axis=0).sum()                 # ... from side to side
    first = int(black[:SECTION_START].argmax())
    end = first + int(np.argmin(np.append(black[first:], False)))
    if end - first < SECTION or end >= len(level):
        return 0
    return end + int(np.argmin(np.append(level[end:] < SHADE * np.median(level[end:end + 4 * SECTION]), False)))


def _shut_in(alpha):
    """The transparent pixels that cannot be reached from the picture's edge."""
    outside = ~alpha
    outside[1:-1, 1:-1] = False
    while True:
        grown = outside.copy()
        grown[1:] |= outside[:-1]
        grown[:-1] |= outside[1:]
        grown[:, 1:] |= outside[:, :-1]
        grown[:, :-1] |= outside[:, 1:]
        grown &= ~alpha
        if (grown == outside).all():
            return ~alpha & ~outside
        outside = grown


class Slab:
    """A run of wall with its thickness: s runs along it, the slab lies between plane - thick and plane.

    height  px above the floor line where its top face lies
    rise    rows from there up to the roofs (a wall drawn cut open), else 0
    """

    def __init__(self, cuts):
        run = cuts[0].face.run
        self.cuts, self.along_u, self.plane = cuts, run.along_u, run.plane
        self.normal = (0.0, 1.0) if self.along_u else (1.0, 0.0)
        clean = [cut for cut in cuts if cut.clean]
        cut_open = [cut for cut in clean if cut.section]
        self.height = np.median([cut.top - cut.section for cut in cut_open]) if 2 * len(cut_open) > len(clean) else proj.ROOF_PX
        tops = [cut.top - self.height for cut in clean]
        self.bands = [band for band in tops if MIN_BAND <= band <= MAX_BAND]     # rows of top face, per clean piece
        self.thick, self.rise = THIN, 0
        # Solid stretches [s from, s to]: all of them, and those that stop the player.
        pieces = [sorted(self.s(cut.at(column)) for column in columns) + [cut.face.solid] for cut in cuts for columns in cut.solid]
        self.stretches = _merged(pieces)
        self.blocking = _merged([piece for piece in pieces if piece[2]])
        self.lo = self.stretches[0][0] if self.stretches else 0.0
        self.hi = max(hi for _, hi in self.stretches) if self.stretches else 0.0
        self.low = self.lo                          # ... of the back, bridges included
        self.bridges = []
        for cut in cuts:
            cut.slab = self

    def set_thickness(self, band):
        self.thick = float(np.clip(max(band, 0) / depth_px(self.along_u), *THICKNESS))
        self.rise = max(0, int(round(proj.ROOF_PX - self.height)))
        for cut in self.cuts:
            cut.cap = cut.section if self.rise and cut.section else int(np.clip(round(cut.top - self.height), 0, cut.rows))

    def s(self, point):
        return point[0] if self.along_u else point[1]

    def point(self, s, depth=0.0):
        """Ground point at s along the slab, `depth` behind its front plane."""
        return (s, self.plane - depth) if self.along_u else (self.plane - depth, s)

    def rect(self, lo, hi):
        """[u0, v0, u1, v1] of the slab between lo and hi."""
        (u0, v0), (u1, v1) = self.point(lo, self.thick), self.point(hi)
        return [u0, v0, u1, v1]

    def covers(self, point):
        (u0, v0, u1, v1), (u, v) = self.rect(self.low, self.hi), point
        return u0 - COVER <= u <= u1 + COVER and v0 - COVER <= v <= v1 + COVER

    def lender(self, s, inward=0, width=0):
        """The nearest piece that lends its material, on the `inward` side of s (+1 / -1, 0 = either)
        and at least `width` wide if there is one; else the nearest piece."""
        away = lambda cut: (self.s(cut.a) + self.s(cut.b)) / 2 - s
        for choice in ([cut for cut in self.cuts if cut.lends and cut.width >= width and away(cut) * inward >= 0],
                       [cut for cut in self.cuts if cut.lends], [cut for cut in self.cuts if cut.width >= width], self.cuts):
            if choice:
                return min(choice, key=lambda cut: abs(away(cut)))

    def strips(self, ends, s, inward, width, back=False):
        """Quads between the ground points `ends` that show `width` columns of this wall's picture:
        [[a, b, sprite, tx, ty, tw, th, z0, z1]], up to the cap line and, in a wall drawn cut open,
        mirrored on above it.

        The columns are those of the lender's edge that is nearer to s. The picture is the
        front's, unless that is the indoor side of an outer wall or `back` asks for the far side.
        """
        cut = self.lender(s, inward, width)
        width = max(1, min(width, cut.width))
        left = abs(self.s(cut.a) - s) < abs(self.s(cut.b) - s)
        own = cut.back < 0 or not (back or cut.sides == (True, False))
        sprite, tx, ty, th = cut.sprite if own else cut.back, 0 if left else cut.width - width, cut.cap if own else 0, cut.rows - cut.cap
        out = [ends + [sprite, tx, ty, width, th, max(cut.z0, 0.0), cut.zc]]
        if self.rise:
            out.append(ends + [sprite, tx, ty + self.rise, width, -self.rise, cut.zc, cut.zc + self.rise / proj.HPX])
        return out

    def open(self, lo, hi):
        """What of [lo, hi] the slab's solid stretches leave open: [[from, to]]."""
        out = []
        for a, b in self.stretches + [[hi, hi]]:
            if a - lo > JOIN and lo < hi:
                out.append([lo, min(a, hi)])
            lo = max(lo, b)
        return out


def _merged(pieces):
    """[[from, to]] of stretches [from, to, ...]; those that touch, or nearly, become one."""
    out = []
    for lo, hi, *_ in sorted(pieces):
        if out and lo <= out[-1][1] + CRACK:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def _thicknesses(slabs):
    """Thickness and cap lines: one thickness for all slabs of a kit; then what each piece is."""
    for along_u in (True, False):
        kits = []
        for slab in sorted((slab for slab in slabs if slab.along_u == along_u and slab.bands), key=lambda slab: np.median(slab.bands)):
            if kits and np.median(slab.bands) - np.median(kits[-1][-1].bands) <= SAME_KIT:
                kits[-1].append(slab)
            else:
                kits.append([slab])
        for kit in kits:
            band = np.median([band for slab in kit for band in slab.bands])
            for slab in kit:
                slab.set_thickness(band)
    for slab in slabs:
        for cut in slab.cuts:
            cut.thick = slab.thick
            cut.sort()
        _figures(slab.cuts)


def _figures(cuts):
    """Plain in outline is not plain in picture: a painted window, a vent, an ornament; and a
    door's casing is no piece of wall. Such a piece stands out from the colours that the plain
    pieces of its wall have at each height (kind 'figure')."""
    plain = [cut for cut in cuts if cut.kind == "plain" and cut.width >= MIN_WIDTH]
    rows = min([cut.rows - cut.cap for cut in plain], default=0) - 3
    if len(plain) < 4 or rows < 4 * EDGE_ROWS:
        return
    body = lambda cut: cut.image[cut.cap:cut.cap + rows].astype(int)
    opaque = np.concatenate([body(cut)[..., 3] > 0 for cut in plain], axis=1)
    colours = np.concatenate([body(cut)[..., :3] for cut in plain], axis=1)
    usual = np.array([np.median(row[there], axis=0) if there.any() else (0, 0, 0) for row, there in zip(colours, opaque)])

    def off(cut):
        """Mean distance of the piece's pixels from the usual colour of their row."""
        picture = body(cut)
        there = picture[..., 3] > 0
        return np.abs(picture[..., :3] - usual[:len(picture), None]).max(axis=2)[there].mean() if there.any() else 0.0

    usually = np.median([off(cut) for cut in plain])
    for cut in cuts:
        # A piece with an opening has a frame, a lintel, shade: more must be different about it.
        limit = max(FIGURE * usually, FIGURE_LEVELS) if cut.kind == "plain" else usually + 2 * FIGURE_LEVELS
        if cut.kind in ("plain", "other") and cut.width >= MIN_WIDTH and off(cut) >= limit:
            cut.kind, cut.lends = "figure", False


# ------------------------------------------------------------------ materials
def _labels(roof):
    """Connected roofs, numbered from 1: one number per building."""
    labels = np.zeros(roof.shape, int)
    for start in zip(*np.nonzero(roof)):
        if labels[start]:
            continue
        number, todo = labels.max() + 1, [start]
        while todo:
            y, x = todo.pop()
            if 0 <= y < roof.shape[0] and 0 <= x < roof.shape[1] and roof[y, x] and not labels[y, x]:
                labels[y, x] = number
                todo += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]
    return labels


def _roof_beyond(labels, point, direction):
    """(units of roof from `point` along `direction`, the building it belongs to).

    Roofs overhang the walls they rest on by up to a square, so only a roof
    that goes on for INDOORS says that this side of a wall is a room.
    """
    depth, building = 0.0, 0
    for d in np.arange(ROOF_STEP, ROOF_REACH + 1e-6, ROOF_STEP):
        u, v = int(np.floor(point[0] + direction[0] * d)), int(np.floor(point[1] + direction[1] * d))
        label = labels[v, u] if 0 <= u < labels.shape[1] and 0 <= v < labels.shape[0] else 0
        if label:
            depth, building = depth + ROOF_STEP, building or label
        elif building or d > ROOF_START:
            break
    return depth, building


def _lent(cut, donor, rows):
    """Rows of `cut` (counted from its cap line, negative ones above it) in the material of
    `donor`: the donor's rows at the same height above the floor, its columns repeated along the wall."""
    rows = rows + int(round((donor.top - donor.cap) - (cut.top - cut.cap)))
    # Along the other axis a unit of wall has more columns, or fewer: step through them accordingly.
    step = abs((proj.SQ_U if donor.face.along_u else proj.SQ_V)[0] / (proj.SQ_U if cut.face.along_u else proj.SQ_V)[0])
    return donor.material(rows, int(cut.width * step) + 1)[:, (np.arange(cut.width) * step).astype(int)]


def _back(cut, donor):
    """The back of `cut` in the picture of `donor`: a window as it is, else the donor's
    material in the outline of `cut`."""
    alpha, c0, c1 = cut.body()
    rows = np.arange(cut.rows - cut.cap)
    if cut.kind == "window":
        out = donor.material(rows + int(round((donor.top - donor.cap) - (cut.top - cut.cap))), cut.width, c0)
        out[:, :c0] = out[:, c1:] = 0
        return out
    out = _lent(cut, donor, rows)
    out[..., 3] = alpha * 255
    out[~alpha] = 0
    return out


def _sides(slabs, roof):
    """Which sides of each piece are indoors (cut.sides), and its building (cut.building).

    Roofs say so, unless a town roofs its alleys too (New Reno). Then the pictures decide: one
    that elsewhere has the open sky in front and a room behind is the outside of a house, also
    where a roof hangs over it; and the wall that such a picture looks at from behind stands
    with its back to the street.
    """
    labels = _labels(roof)
    middle = lambda cut: (cut.slab.s(cut.a) + cut.slab.s(cut.b)) / 2
    for slab in slabs:
        n = np.array(slab.normal)
        for cut in slab.cuts:
            at = (np.array(cut.a) + cut.b) / 2
            (front, front_roof), (back, back_roof) = _roof_beyond(labels, at, n), _roof_beyond(labels, at - n * slab.thick, -n)
            cut.sides = front >= INDOORS, back >= INDOORS
            cut.building = front_roof if cut.sides[0] else back_roof
    seen = Counter((cut.face.art, cut.sides) for slab in slabs for cut in slab.cuts if cut.width >= MIN_WIDTH)
    outside = lambda cut: seen[cut.face.art, (False, True)] >= max(2, OUTSIDE * seen[cut.face.art, (True, False)])
    for slab in slabs:
        behind = [other for other in slabs if other.along_u == slab.along_u and 0 < slab.plane - slab.thick - other.plane < ROOF_REACH]
        for cut in slab.cuts:
            if cut.sides != (True, True):
                continue
            facing = [other for other in behind if other.lo - REACH <= middle(cut) <= other.hi + REACH]
            if outside(cut):
                cut.sides = (False, True)
            elif facing and outside(min(max(facing, key=lambda other: other.plane).cuts, key=lambda piece: abs(middle(piece) - middle(cut)))):
                cut.sides = (True, False)


def _materials(slabs, roof, sprite):
    """Give the walls between indoors and outdoors the other side's material (cut.back), and
    walls drawn cut open what goes on above the cut (cut.above)."""
    _sides(slabs, roof)
    span = lambda cut: cut.body()[2] - cut.body()[1]
    donors, wanted = {}, []
    for slab in slabs:
        for cut in slab.cuts if slab.thick >= MIN_SOLID else ():           # a fence is a fence from both sides
            if cut.sides[0] == cut.sides[1] or cut.kind == "figure" or not span(cut):
                continue
            middle = (np.array(cut.a) + cut.b) / 2
            kind = "window" if cut.kind == "window" else "plain"            # what it wants: such a window, or material
            if cut.lends or cut.kind == "window":
                donors.setdefault((cut.building, slab.along_u, cut.sides[0], kind), []).append((middle, cut))
            wanted.append((cut, middle, slab.along_u, kind))
    for cut, middle, along_u, kind in wanted:
        for axis in (along_u, not along_u) if kind == "plain" else (along_u,):
            near = [(np.hypot(*(middle - where)), n, donor)
                    for n, (where, donor) in enumerate(donors.get((cut.building, axis, cut.sides[1], kind), ()))
                    if kind == "plain" or span(donor) == span(cut)]
            if near:
                cut.donor = min(near)[2]
                cut.back = sprite(_back(cut, cut.donor))
                break
    for slab in slabs:
        for cut in slab.cuts if slab.rise else ():
            if cut.top - cut.cap > slab.height - 2:            # it reaches the cut
                lenders = [of.slab.lender(of.slab.s(of.a), width=cut.width) for of in (cut, cut.donor or cut)]
                cut.above = [sprite(_lent(cut, lender, np.arange(-slab.rise, 0))) for lender in lenders]


# ------------------------------------------------------------------- geometry
def _trims(slabs):
    """The upright quads that close the slabs: [[a, b, sprite, tx, ty, tw, th, z0, z1]].

    Each shows columns tx .. tx + tw, rows ty .. ty + th of its sprite between
    ground points a and b (a on the left as one looks at it).
    """
    out = []
    solid = [slab for slab in slabs if slab.thick >= MIN_SOLID and slab.stretches]
    for slab in solid:
        for other in solid:
            # Another wall that starts at this one and goes on in front of it ...
            if other.along_u == slab.along_u or not -REACH <= other.lo - slab.plane + slab.thick <= slab.thick + REACH:
                continue
            for lo, hi in slab.open(other.plane - other.thick, other.plane):     # ... across the stretch this one leaves open
                lo = max([end for _, end in slab.stretches if lo - REACH <= end <= lo], default=lo)
                hi = min([start for start, _ in slab.stretches if hi <= start <= hi + REACH], default=hi)
                if hi > slab.lo - REACH and lo < slab.hi + REACH and hi - lo > JOIN:
                    slab.bridges.append((lo, hi))
                    slab.low = min(slab.low, lo)
    for slab in solid:
        behind = lambda s: slab.point(s, slab.thick)
        px = abs((proj.SQ_U if slab.along_u else proj.SQ_V)[0])     # columns of picture per unit of wall
        # Seen from its outside a quad runs from left to right; s grows that way on the back of a
        # wall along u and on the front of one along v.
        ordered = lambda low, high, grows: [low, high] if grows else [high, low]
        for lo, hi in slab.bridges:
            out += slab.strips(ordered(behind(lo), behind(hi), slab.along_u), (lo + hi) / 2, 0, int(round((hi - lo) * px)), back=True)
        for stretch in slab.stretches:
            for s, inward in zip(stretch, (1, -1)):
                if any(other is not slab and other.covers(slab.point(s, slab.thick / 2)) for other in solid) \
                        or any(abs(s - end) < JOIN for bridge in slab.bridges for end in bridge):
                    continue
                # The end faces away from the wall: towards -s at a low end, where the front is
                # on the left of a wall along u (its outside is towards +v).
                out += slab.strips(ordered(slab.point(s), behind(s), slab.along_u == (inward > 0)), s, inward, int(round(slab.thick * px)))
    return out


def thicken(cuts, roof, sprite):
    """Work out thickness, cap line, back and the rest of every wall cut; -> (trims, boxes).

    cuts    every exported face (sheets and doors pass through untouched)
    roof    100x100 bool: squares with a roof
    sprite  callable: image -> sprite index
    boxes   [u0, v0, u1, v1]: the slabs that stop the player
    """
    by_run = {}
    for cut in cuts:
        if cut.face.kind == "wall" and cut.face.run is not None:
            by_run.setdefault(id(cut.face.run), []).append(cut)
    slabs = {run: Slab(members) for run, members in by_run.items()}
    _thicknesses(slabs.values())
    _materials(slabs.values(), roof, sprite)
    trims = _trims(slabs.values())
    # Where a door hangs in a wall one walks through, whatever the frame's picture covers there
    # (the deep casings of Vault City are painted across half their doorway).
    for cut in cuts:
        slab = slabs.get(id(cut.face.run)) if cut.face.kind == "door" else None
        if slab:
            lo, hi = sorted((slab.s(cut.a), slab.s(cut.b)))
            slab.blocking = [[a, b] for start, end in slab.blocking for a, b in ((start, min(end, lo)), (max(start, hi), end)) if b - a > JOIN]
    return trims, [slab.rect(lo, hi) for slab in slabs.values() for lo, hi in slab.blocking + slab.bridges]
