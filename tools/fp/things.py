"""How doors, scenery and items stand in the world: a sheet like a wall, a sprite card, or flat.

The game's art only says what an object looks like from one side; whether a
sprite is a sheet standing along u, one standing along v, a card that faces
the viewer or something lying on the floor has to be decided. Evidence:

1. Proto data, where it is reliable: the FLAT flag (decals, scene.py), the door
   subtype (a door is a sheet in the wall it closes, walls.door_axis) and, for
   doors without wall neighbours, the orientation bits. For other scenery the
   bits are too often the unset default to decide anything.

2. The picture (`image_axis`). A sprite is a sheet along an axis when
   - its lower and upper edge both follow that wall slope (signs, posters), or
   - its lower edge follows the slope for at least PLANAR_FIT of its width, it
     is at least PLANAR_MIN_WIDTH wide and it is `thin` (fences, railings,
     shelves, bookcases, counters). A sheet shows the whole sprite, so the
     depth of the object across the sheet becomes extra length and height:
     its side and its top are painted on. `footprint` estimates the object's
     box from the sprite; up to about a third is tolerable, a bed or a table
     would become a wall with a picture of a bed on it and stays a card.

3. The game's draw order, which is ground truth about depth: the game paints
   hex by hex, so wherever two sprites overlap on screen the one painted later
   is in front. Every candidate shape is put into the scene built so far and
   the pixels that contradict the game are counted (`violations`: the shape
   hidden by something painted before it, or covering a wall painted after
   it). `stand` tries, in this order, and takes the first shape that agrees:

       sheet along the picture's axis   if rule 2 found one
       card                             the default: faces the viewer, sorted
                                        by its hex (proj.card, proj.row_plane)
       sheet along the offending wall,  only for what is thin, hangs in the air
       then along the other axis        (vents, lamps: on a wall or not at all)
                                        or stands inside the wall: on its hex
                                        row or column, behind its face, and yet
                                        painted over it (ropes, graffiti, rocks
                                        at a cave wall)
       flat on the floor                low piles that spill under a wall
                                        painted after them

   If none agrees, the one with the fewest wrong pixels wins. Beds, tables and
   cars against a wall end up there: too deep for a sheet, and as cards their
   far end can reach through the wall. Once everything stands, a sheet that
   hides things painted after it becomes a card again (`reconsider`).

A sheet stands on its own floor line (the line under its silhouette); when
that puts it inside or behind a parallel wall the game paints before it, it is
seated a skin in front of that wall instead (`seat`). That is also how doors
get the plane of the wall they close.
"""
import numpy as np

from . import proj, walls

PLANAR_FIT = 0.6        # share of columns whose lower edge follows one wall slope: a sheet, if thin
PLANAR_MIN_WIDTH = 24   # px; narrower things stay cards (a card that narrow looks the same)
MAX_TOP_SHARE = 0.35    # of a sheet's height that may really be the top of the object
MAX_SIDE_SHARE = 0.34   # of a sheet's length that may really be the side of the object
INSIDE = 0.02           # units: a hex this close in front of a wall's face is still in the wall
NEAR = 0.3              # units: a parallel face this close behind a sheet belongs to the wall the sheet is on
SEAT_REACH = 1.0        # units: how far from a wall a sheet may be and still belong on it
FLAT_MAX_HEIGHT = 48    # px: only low sprites may be laid on the floor
CELL = 128              # px, bucket size of the shape index


class Card:
    """A sprite card on its hex (proj.card). hexagon = world pixel of the hex centre; the
    sprite's top-left pixel is (left, top) from there (object x / y included)."""

    kind, run = "card", None

    def __init__(self, tile, alpha, left, top, order, stack=0):
        self.tile, self.alpha, self.left, self.top, self.order, self.stack = tile, alpha, left, top, order, stack
        self.hexagon = proj.hex_px(tile)

    def pixels(self):
        return self.alpha, int(round(self.hexagon[0])) + self.left, int(round(self.hexagon[1])) + self.top

    def depth(self):
        """Depth key of each pixel: its height on the plane of the card's hex row (proj.row_plane)."""
        opaque, x, y = self.pixels()
        h, w = opaque.shape
        floor = proj.plane_floor_y(proj.row_plane(self.tile, self.stack), x + np.arange(w) + 0.5)
        return (floor[None, :] - (y + np.arange(h)[:, None] + 0.5)) / proj.HPX


def depth(shape):
    """Depth key of each of the shape's pixels(): the height of its fragment there."""
    if shape.kind == "card":
        return shape.depth()
    opaque, x, y = shape.pixels()
    h, w = opaque.shape
    floor = shape.centre[1] + shape.c + shape.slope * (x + np.arange(w) + 0.5 - shape.centre[0])
    return (floor[None, :] - (y + np.arange(h)[:, None] + 0.5)) / proj.HPX


class Index:
    """Everything standing so far (wall faces, sheets, cards) by screen position."""

    def __init__(self, shapes=()):
        self.cells = {}
        self.gone = set()
        for shape in shapes:
            self.add(shape)

    def remove(self, shape):
        self.gone.add(id(shape))

    @staticmethod
    def _box(shape):
        opaque, x, y = shape.pixels()
        return x, y, x + opaque.shape[1], y + opaque.shape[0]

    @staticmethod
    def _cells(box):
        return [(i, j) for i in range(box[0] // CELL, (box[2] - 1) // CELL + 1)
                for j in range(box[1] // CELL, (box[3] - 1) // CELL + 1)]

    def add(self, shape):
        box = self._box(shape)
        for cell in self._cells(box):
            self.cells.setdefault(cell, []).append((shape, box))

    def overlapping(self, shape):
        """[(other, pixels both show, window in shape, window in other)]"""
        opaque = shape.pixels()[0]
        box = self._box(shape)
        seen, hits = set(), []
        for cell in self._cells(box):
            for other, theirs in self.cells.get(cell, ()):
                if id(other) in seen or id(other) in self.gone or other is shape:
                    continue
                seen.add(id(other))
                ax, ay, bx, by = max(box[0], theirs[0]), max(box[1], theirs[1]), min(box[2], theirs[2]), min(box[3], theirs[3])
                if ax >= bx or ay >= by:
                    continue
                a = (slice(ay - box[1], by - box[1]), slice(ax - box[0], bx - box[0]))
                b = (slice(ay - theirs[1], by - theirs[1]), slice(ax - theirs[0], bx - theirs[0]))
                both = opaque[a] & other.pixels()[0][b]
                if both.any():
                    hits.append((other, both, a, b))
        return hits


def violations(shape, index):
    """Pixels where the shape's depth contradicts the game's draw order.

    -> (count, {other shape: pixels}): pixels hidden by something the game paints before the
    shape, and pixels of walls the game paints after the shape that it covers.
    """
    mine = depth(shape)
    by_other = {}
    for other, both, a, b in index.overlapping(shape):
        if shape.run is not None and other.kind == "wall" and other.along_u == shape.along_u:
            own_wall = abs(other.plane() - shape.run.plane) < 1e-4
            if own_wall or (other.order > shape.order and 0 <= shape.plane() - other.plane() < NEAR):
                continue                                # the wall it is on, or a later piece of it: see trim
        theirs = depth(other)[b]
        n = int((both & ((mine[a] < theirs) if other.order < shape.order else (mine[a] > theirs))).sum())
        if n:
            by_other[other] = n
    return sum(by_other.values()), by_other


def seat(face, index, skin, beside=()):
    """Put a sheet a skin in front of the parallel wall it would otherwise be inside or behind.

    Only walls that the game paints before the sheet and that share pixels with
    it count: being painted over them proves the sheet is in front of them.
    beside: the wall runs through the tiles next to a door along its axis;
    without a wall behind it a door joins the wall (or fence) line it closes.
    """
    best = None
    for wall, _, _, _ in index.overlapping(face):
        if wall.kind == "wall" and wall.along_u == face.along_u and wall.order < face.order and wall.run is not None:
            if best is None or wall.run.plane > best.plane:
                best = wall.run
    if best is not None and -SEAT_REACH < face.plane() - best.plane < skin:
        face.move_to(best.plane + skin)
        face.run = best
    elif beside:
        lines = [run for run in beside if abs(run.plane - face.plane()) < SEAT_REACH]
        if lines:
            face.run = max(lines, key=lines.count)
            face.move_to(face.run.plane + skin)


def trim(face, index):
    """A sheet on a wall loses the pixels that later pieces of that wall paint over it.

    A door or a poster stands a skin in front of its wall and takes nothing away
    from it (the wall behind a door must still be there when the door opens),
    but where the game paints a later piece of the same wall over the sheet -
    the next frame post, the tent pole to its left - the sheet has a hole.
    "The same wall" is any parallel face at most NEAR behind the sheet.
    """
    opaque, _, _ = face.pixels()
    keep = opaque.copy()
    for wall, _, a, b in index.overlapping(face):
        if wall.kind == "wall" and wall.along_u == face.along_u and wall.order > face.order \
                and 0 <= face.plane() - wall.plane() < NEAR:
            c0, c1 = wall.columns()
            keep[a] &= ~wall.alpha[:, c0:c1][b]
    if keep.sum() != opaque.sum():
        face.mask = keep


def footprint(alpha, left, top):
    """Rough size of the object as a box: (a along u, b along v, height) in units.

    The lowest point of a sprite is the near corner of the object's footprint.
    The columns left of it show the side along v (SQ_V: 32 px per unit), those
    right of it the side along u (SQ_U: 48 px per unit), and what is left of the
    sprite's height after the screen height of that footprint is the object's
    own height.
    """
    x, lower, upper = walls._edges(alpha, left, top)
    corner = x[lower >= lower.max() - 1].mean()
    a, b = (x.max() - corner) / abs(proj.SQ_U[0]), (corner - x.min()) / proj.SQ_V[0]
    height = (lower.max() - upper.min() - a * proj.SQ_U[1] - b * proj.SQ_V[1]) / proj.HPX
    return a, b, height


def thin(alpha, left, top, axis):
    """Can the object pass for a sheet along `axis`? Only if it has little depth across it.

    A sheet shows the whole sprite, so the object's depth ends up as extra length
    (the side) and extra height (the top) of the sheet.
    """
    a, b, height = footprint(alpha, left, top)
    across, step = (b, proj.SQ_V) if axis == "u" else (a, proj.SQ_U)
    wide = across * abs(step[0]) / max(alpha.any(axis=0).sum(), 1)
    tall = across * step[1] / max(height * proj.HPX + across * step[1], 1e-6)
    return wide <= MAX_SIDE_SHARE and tall <= MAX_TOP_SHARE


def image_axis(alpha, left, top):
    """'u' or 'v' if the picture is a sheet along that axis, else None (rule 2 above)."""
    x, lower, upper = walls._edges(alpha, left, top)
    if len(x) < walls.PANEL_MIN_WIDTH:
        return None
    fits = walls._straight(x, lower, upper, left, left + alpha.shape[1])
    best = max(fits, key=lambda axis: fits[axis][0])
    low, high = fits[best][:2]
    if min(low, high) >= walls.PANEL_FIT:
        return best
    if low >= PLANAR_FIT and len(x) >= PLANAR_MIN_WIDTH and thin(alpha, left, top, best):
        return best
    return None


def sheet(obj, art, centre, sprite, axis, order, index):
    """The object as a wall-like face along `axis`, seated on the wall behind it if it touches one.

    None if it hangs in the air with no wall to hang on: without a floor line
    there is no telling where its plane is (cliff tops, lamps), so it stays a card.
    """
    slope, c, x_from, x_to = walls.floor_line(*sprite, axis)
    face = walls.Face(obj, art, centre, slope, c, x_from, x_to, True, False, "panel", order, sprite)
    hanging = c < -walls.HANGING_PX
    if hanging:
        face.c = 0.0                            # try it above the hex centre
    seat(face, index, walls.SKIN)
    return None if hanging and face.run is None else face


def door(obj, art, centre, sprite, axis, order, index, runs_by_tile):
    """A door: a sheet in the wall it closes."""
    slope, c, x_from, x_to = walls.floor_line(*sprite, axis)
    face = walls.Face(obj, art, centre, slope, c, x_from, x_to, False, False, "door", order, sprite)
    beside = [runs_by_tile.get((axis == "u", tile)) for tile in walls.beside(obj.tile, axis == "u")]
    seat(face, index, walls.DOOR_SKIN, [run for run in beside if run is not None])
    return face


def reconsider(face, index, stack):
    """A sheet that turns out to hide things the game paints after it: its card, if that is better.

    stand() only sees what was painted before; a cliff or a pile of boxes whose
    base line lies far in front of its hex, or a plant taken for part of the
    wall beside it, is found out by what comes later.
    """
    alpha, left, top = face.alpha, face.left, face.top
    wrong = violations(face, index)[0]
    if wrong <= max(6, int(alpha.sum()) // 100):
        return face
    card = Card(face.obj.tile, alpha, left + face.obj.x, top + face.obj.y, face.order, stack)
    return card if violations(card, index)[0] < wrong else face


def stand(obj, art, centre, sprite, order, index, stack):
    """-> the shape that agrees best with the game: a walls.Face, a Card, or 'flat'.

    stack: how many cards already stand on the object's hex."""
    alpha, left, top = sprite
    tolerance = max(6, int(alpha.sum()) // 100)
    tried = []

    def good(shape):
        if shape is None:
            return False
        wrong, by_other = violations(shape, index)
        tried.append((wrong, len(tried), shape, by_other))
        return wrong <= tolerance

    axis = image_axis(*sprite)
    if axis and good(sheet(obj, art, centre, sprite, axis, order, index)):
        return tried[-1][2]
    if good(Card(obj.tile, alpha, left + obj.x, top + obj.y, order, stack)):
        return tried[-1][2]
    by_other = tried[-1][3]
    against = [other for other in by_other if other.kind == "wall"]     # only walls are fixed points
    hanging = top + alpha.shape[0] <= 0
    if against:
        worst = max(against, key=by_other.get)
        row, column = proj.row_plane(obj.tile), proj.px_to_ground(*proj.hex_px(obj.tile))[0]
        for axis in ("uv" if worst.along_u else "vu"):
            # Inside a wall: on its own hex row (along u) or column (along v), not in front of
            # its face, and yet painted over it.
            inside = any(wall.order < order and wall.along_u == (axis == "u")
                         and (row if axis == "u" else column) <= wall.run.plane + INSIDE for wall in against)
            if (hanging or inside or thin(*sprite, axis)) and good(sheet(obj, art, centre, sprite, axis, order, index)):
                return tried[-1][2]
    best = min(tried, key=lambda t: t[:2])
    low = not hanging and alpha.shape[0] <= FLAT_MAX_HEIGHT
    if low and against and all(other.order > order for other in by_other):
        # It only covers walls painted after it: it may lie on the floor. But as a decal it is
        # under everything upright, also under what the game paints before it.
        under = sum(int(both.sum()) for other, both, _, _ in index.overlapping(best[2]) if other.order < order)
        if under < best[0]:
            return "flat"
    return best[2]
