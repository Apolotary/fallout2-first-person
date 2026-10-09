"""Wall sprites -> upright textured quads ("un-shearing").

A wall sprite is a picture of a vertical face that runs along world axis u or
v. On screen a step along u goes 4 px left per 1 px down (slope -1/4), a step
along v goes 4 px right per 3 px down (slope +3/4), and height is straight up.
So on the vertical plane that contains the face, a sprite pixel (x, y) (pixels
relative to the hex centre) sits at

    along = x / axis.x   world units from the plane's reference point
    z     = (c + slope * x - y) / HPX

where y = c + slope * x is the line on which the face meets the floor. Removing
`slope * x` from every column turns the sheared sprite into a rectangular
texture; because the shift per column is a whole number of pixels the texture
holds exactly the sprite's pixels, and iso mode puts every one of them back
where the game draws it.

Classification of a wall piece (`classify`), from the shape of the lower edge
of its silhouette with the proto's orientation bits as a prior:

    u        straight, runs along u ("East/West" protos, 0x08000000)
    v        straight, runs along v ("North/South" protos, no bits)
    corner-n two faces, u on the left and v on the right of the far corner
    corner-s two faces, v on the left and u on the right of the near corner
    board    pillar or unrecognised shape: drawn as a camera-facing sprite card

Straight-wall protos keep their class whatever the picture looks like (lintels,
ruins and overgrown pieces have no clean edge; the bits are reliable). Corner
protos are split in two faces only when the picture shows two; many "east" and
"west" corner pieces really are one face with an end cap.

`c` first comes from the image (the supporting line under the silhouette), so a
piece stands on the floor wherever its art says, not at an assumed offset. Then

    align             gives all faces of one wall run the same plane
    fold_ends         turns what overhangs a corner onto the wall around the corner
    resolve_overlaps  gives every pixel of a plane to the face the game paints last
    solid_runs        says which stretches of a face stop the player

Doors and flat scenery become faces too (things.py seats them on these planes).
boxes.py then gives the walls what a picture on a plane lacks: thickness, a top,
a far side.

What iso mode proves: any plane puts a sprite's pixels back where they came
from, so the picture only shows which of two overlapping sprites is in front.
That is still a strong test, because the game paints in hex order: a face on
the wrong plane ends up in front of (or behind) a neighbour that the game
paints the other way round. The exporter keeps that ordering.
"""
import numpy as np

from f2lib import geometry

from . import proj

# Proto extended-flag orientation bits (research/05 section 10.3) -> expected class.
PRIOR = {0x00: "v", 0x08: "u", 0x10: "corner-n", 0x20: "corner-s", 0x40: "u", 0x80: "v"}
INLIER_PX = 1.5         # a column agrees with a line when its lower edge is this close
GOOD_FIT = 0.6          # fraction of agreeing columns needed to trust the image
DOOR_FIT = 0.4          # a lone door goes by its edges, which the frame cuts short: less will do
PANEL_FIT = 0.85        # both edges of a sign or poster follow the wall slope
PANEL_MIN_WIDTH = 12
HANGING_PX = 12         # a sheet whose lower edge is this far above its hex hangs on a wall
SKIN = 0.03             # units a sheet stands off the wall it is seated on
DOOR_SKIN = 0.01        # units a door stands in front of the plane of its wall
FOLD_REACH = 0.45       # units: a run "ends at" a crossing wall when it stops within this distance of it
CORNER_REACH = 0.56      # units: ... and the crossing wall may stop this far short of the run (a corner post
                        # that belongs to the run stands in for the crossing wall's last hex)
SAME_LINE = 0.08        # units: stretches of wall on one hex row this close in depth are one line
OFF_LINE = 0.75         # units: no wall face is this far from the line through its hexes
RUN_GAP_PX = 2          # faces of one wall run touch on screen, give or take this
ZIGZAG_OVERLAP_PX = 12  # pieces of one line on two hex rows meet end to end: they overlap at most this much
PASS_HEIGHT = 0.9       # a hole this tall (units) ...
HEAD_ROOM = 1.25        # ... below this height lets the player through a wall face
MIN_SIDE = 4            # columns each face of a corner needs


def _edges(alpha, left, top):
    """Opaque columns: x of the column centre, y just below the lowest and at the highest opaque pixel."""
    cols = np.flatnonzero(alpha.any(axis=0))
    below = alpha.shape[0] - np.argmax(alpha[::-1][:, cols], axis=0)
    above = np.argmax(alpha[:, cols], axis=0)
    return cols + 0.5 + left, (below + top).astype(float), (above + top).astype(float)


def _kth(values, largest):
    """Robust extreme: the second most extreme column (one stray pixel must not decide,
    but a door jamb two pixels wide must)."""
    k = min(1, len(values) - 1)
    ordered = np.sort(values)
    return ordered[-1 - k] if largest else ordered[k]


def _agree(residual, c):
    return float(np.mean(np.abs(residual - c) <= INLIER_PX))


def _straight(x, lower, upper, left, right):
    """Fit one floor line of each slope: {class: (lower-edge agreement, upper-edge agreement, faces)}.

    The floor line is the supporting line under the silhouette (a lintel or
    window that does not reach the floor must not pull it up).
    """
    fits = {}
    for name, slope in (("u", proj.U_SLOPE), ("v", proj.V_SLOPE)):
        c = _kth(lower - slope * x, largest=True)
        top_c = _kth(upper - slope * x, largest=False)
        fits[name] = (_agree(lower - slope * x, c), _agree(upper - slope * x, top_c), [(slope, c, left, right)])
    return fits


def classify(alpha, left, top, ext_flags=None):
    """-> (class, source, faces); faces = [(slope, c, x_from, x_to)] in px relative to the hex centre.

    alpha      (h, w) bool, the sprite's opaque pixels
    left, top  position of the sprite's top-left pixel relative to the hex centre
    ext_flags  proto extended flags (walls) or None (doors: image only, never a corner)
    source     'fit' when the silhouette agrees, 'flag' when only the proto bits decided
    """
    x, lower, upper = _edges(alpha, left, top)
    if len(x) == 0:
        return "board", "fit", []
    right = left + alpha.shape[1]
    prior = PRIOR.get((ext_flags >> 24) & 0xF8) if ext_flags is not None else None
    # A straight piece counts as recognised when its lower or its upper edge follows the slope.
    fits = {name: (max(low, high), faces) for name, (low, high, faces) in _straight(x, lower, upper, left, right).items()}
    if prior in ("u", "v"):                      # the straight-wall bits are never wrong in retail data
        return prior, "fit" if fits[prior][0] >= GOOD_FIT else "flag", fits[prior][1]
    if ext_flags is None:
        best = max(fits, key=lambda name: fits[name][0])
        return (best, "fit", fits[best][1]) if fits[best][0] >= DOOR_FIT else ("board", "fit", [])

    # Corner protos: the lower edge is the upper (far corner) or lower (near corner)
    # envelope of one line of each slope; the lines cross at x = cu - cv.
    res_u, res_v = lower - proj.U_SLOPE * x, lower - proj.V_SLOPE * x
    for name, largest in (("corner-n", False), ("corner-s", True)):
        cu, cv = _kth(res_u, largest), _kth(res_v, largest)
        lines = np.stack([cu + proj.U_SLOPE * x, cv + proj.V_SLOPE * x])
        model = lines.min(axis=0) if largest else lines.max(axis=0)
        split = float(np.clip(round(cu - cv - left) + left, left, right))
        if min(np.sum(x < split), np.sum(x > split)) < MIN_SIDE:
            continue
        first, second = ((proj.U_SLOPE, cu), (proj.V_SLOPE, cv)) if name == "corner-n" else \
                        ((proj.V_SLOPE, cv), (proj.U_SLOPE, cu))
        fits[name] = (_agree(lower, model), [first + (left, split), second + (split, right)])
    best = max(fits, key=lambda name: fits[name][0] + (0.15 if name == prior else 0.0))
    if fits[best][0] >= GOOD_FIT:
        return best, "fit", fits[best][1]
    return "board", "fit", []


def floor_line(alpha, left, top, axis):
    """The face (slope, c, x_from, x_to) of a sprite known to run along `axis` ('u' or 'v')."""
    x, lower, upper = _edges(alpha, left, top)
    return _straight(x, lower, upper, left, left + alpha.shape[1])[axis][2][0]


def door_axis(tile, wall_tiles, ext_flags, alpha, left, top):
    """Which way a door runs: 'u' or 'v'.

    A door closes a gap in a wall, so the wall pieces beside it decide: along
    u they stand on the same hex row (tile +-1, +-2), along v on the same hex
    column (tile +-200, +-400). A door without neighbours goes by its proto's
    orientation bits (in scenery protos 0x08 and 0x80 both mean "along u": of
    the 214 scenery sprites with those bits and a clean lower edge, 209 run
    along u; no bits is the default and says nothing), and only then by its edges.
    """
    row = sum(tile + k in wall_tiles for k in (-2, -1, 1, 2))
    column = sum(tile + k * geometry.HEX_WIDTH in wall_tiles for k in (-2, -1, 1, 2))
    if row != column:
        return "u" if row > column else "v"
    if (ext_flags >> 24) & 0x88:
        return "u"
    x, lower, upper = _edges(alpha, left, top)
    fits = _straight(x, lower, upper, left, left + alpha.shape[1])
    best = max(fits, key=lambda name: max(fits[name][:2]))
    return best if max(fits[best][:2]) >= DOOR_FIT else "v"


def unshear(rgba, left, top, slope, x_from, x_to, mask=None):
    """One face -> (texture, x0, x1, y_top), or None if those columns are empty.

    mask: which of the columns' pixels the face still shows (see resolve_overlaps).

    Texture column i is sprite column (x_from - left + i), moved up or down by
    a whole number of pixels so that lines along the wall become horizontal.
    x0 / x1 are the screen x of the texture's left / right edge relative to the
    hex centre; texture row j covers un-sheared y (= y - slope * x) in
    [y_top + j, y_top + j + 1].
    """
    c0, c1 = int(round(x_from - left)), int(round(x_to - left))
    part = rgba[:, c0:c1]
    if mask is not None:
        part = part * mask[..., None]
    height, width = part.shape[:2]
    if width == 0 or not part[..., 3].any():
        return None
    centre_x = left + c0 + np.arange(width) + 0.5
    # Un-sheared row of sprite row 0: pixel centre y - slope * x, floored.
    row0 = np.floor(top + 0.5 - slope * centre_x).astype(int)
    first = int(row0.min())
    out = np.zeros((height + int(row0.max()) - first, width, 4), np.uint8)
    for i in range(width):
        out[row0[i] - first:row0[i] - first + height, i] = part[:, i]
    rows = np.flatnonzero(out[..., 3].any(axis=1))
    return out[rows[0]:rows[-1] + 1], left + c0, left + c1, first + int(rows[0])


class Face:
    """One wall face of one map object: a vertical rectangle waiting for its final plane.

    The face shows columns [x_from, x_to) of the object's sprite (px relative
    to `centre`, the world pixel of the object's anchor). `sprite` = (opaque
    pixels of the whole frame, left, top) with (left, top) relative to centre.
    """

    __slots__ = ("obj", "art", "centre", "slope", "c", "x_from", "x_to", "trusted", "solid",
                 "kind", "order", "alpha", "left", "top", "mask", "run")

    def __init__(self, obj, art, centre, slope, c, x_from, x_to, trusted, solid=False, kind="wall", order=0, sprite=None):
        self.obj, self.art, self.centre = obj, art, centre
        self.slope, self.c, self.x_from, self.x_to, self.trusted = slope, c, x_from, x_to, trusted
        self.solid = solid                       # stops the player (walls; not doors or signs)
        self.kind = kind                         # 'wall', 'door' or 'panel'
        self.order = order                       # the engine draws faces in ascending order
        self.alpha, self.left, self.top = sprite
        self.mask = None                         # what is left of pixels() once overlaps are resolved
        self.run = None                          # the Run whose plane the face lies in

    @property
    def along_u(self):
        return self.slope < 0

    def ends(self, x0=None, x1=None):
        """Ground points under screen x0 and x1 (default: the face's own extent)."""
        x0 = self.x_from if x0 is None else x0
        x1 = self.x_to if x1 is None else x1
        return [proj.px_to_ground(self.centre[0] + x, self.centre[1] + self.c + self.slope * x) for x in (x0, x1)]

    def plane(self):
        """The coordinate that is constant on the face: v for a face along u, u for one along v."""
        return self.ends()[0][1 if self.along_u else 0]

    def span(self):
        a, b = (p[0 if self.along_u else 1] for p in self.ends())
        return min(a, b), max(a, b)

    def move_to(self, plane):
        """Slide the face to another plane without moving its picture on the game's screen.

        Moving the plane one unit towards the camera lowers the floor line by the
        screen height of that step measured at constant x.
        """
        ox, oy = proj.SQ_V if self.along_u else proj.SQ_U
        self.c += (plane - self.plane()) * (oy - self.slope * ox)

    def columns(self):
        """The face's columns as indices into the sprite frame."""
        return int(round(self.x_from - self.left)), int(round(self.x_to - self.left))

    def pixels(self):
        """(opaque[h, w], X, Y): the face's visible pixels and the world pixel of their top-left corner."""
        c0, c1 = self.columns()
        opaque = self.alpha[:, c0:c1] if self.mask is None else self.mask
        return opaque, int(round(self.centre[0] + self.left)) + c0, int(round(self.centre[1] + self.top))

    def part(self, x_from, x_to, slope=None):
        """Columns [x_from, x_to) as a face of their own, optionally on the other axis (plane still to be set)."""
        twin = Face(self.obj, self.art, self.centre, self.slope if slope is None else slope, self.c, x_from, x_to,
                    False, self.solid, self.kind, self.order, (self.alpha, self.left, self.top))
        twin.run = self.run
        return twin


class Run:
    """Faces that form one straight stretch of wall: they share a plane."""

    def __init__(self, faces, plane):
        self.faces = faces
        self.along_u = faces[0].along_u
        self.plane = plane
        for face in faces:
            face.run = self

    def span(self):
        spans = [face.span() for face in self.faces if face.kind == "wall"]
        return min(lo for lo, _ in spans), max(hi for _, hi in spans)


def hex_line(face):
    """The face's hex as a plane coordinate: v of its hex row (along u) or u of its hex column."""
    hx, hy = geometry.tile_xy(face.obj.tile)
    if face.along_u:
        return proj.px_to_ground(*proj.hex_px(geometry.tile_at(hx & ~1, hy)))[1]
    return proj.px_to_ground(*proj.hex_px(face.obj.tile))[0]


def _chains(pieces):
    """Faces grouped into stretches of wall: [[Face]].

    Faces along u on one hex row (along v: one hex column) that touch on screen
    are one stretch. A line along u zigzags over the hexes, though, and some
    walls use the hexes of two rows for it: fence posts on the odd hexes of one
    row, the rails between them on the even hexes of the row behind. So a lone
    piece also joins the stretch on the neighbouring row that it touches end
    to end (an even hex continues on the odd hexes of the next row and vice
    versa); two real walls on adjacent rows overlap instead and stay apart.
    """
    rows = {}
    for piece in pieces:
        for face in piece:
            hx, hy = geometry.tile_xy(face.obj.tile)
            rows.setdefault((face.along_u, hy if face.along_u else hx), []).append(face)
    chains, where = [], {}
    left = lambda f: f.centre[0] + f.x_from
    right = lambda f: f.centre[0] + f.x_to
    for key, faces in rows.items():
        faces.sort(key=left)
        for face in faces:
            if where.get(key) and left(face) <= max(right(f) for f in where[key][-1]) + RUN_GAP_PX:
                where[key][-1].append(face)
            else:
                where.setdefault(key, []).append([face])
        chains += where[key]
    for chain in [c for c in chains if len(c) == 1 and c[0].along_u]:
        face = chain[0]
        hx, hy = geometry.tile_xy(face.obj.tile)
        odd = hx & 1
        for other in where.get((True, hy - 1 if odd else hy + 1), ()):
            ends = [f for f in other if (f.obj.tile % geometry.HEX_WIDTH) & 1 != odd
                    and -RUN_GAP_PX <= min(right(f), right(face)) - max(left(f), left(face)) <= ZIGZAG_OVERLAP_PX]
            if ends and other is not chain:
                other += chain
                chain.clear()
                break
    return [chain for chain in chains if chain]


def align(pieces):
    """Put the faces of one wall run on one plane and re-cut corners where their faces now meet. -> [Run]

    Every sprite gets its floor line from its own art, so neighbours of one wall
    come out a pixel or two apart in depth (cracks you can see through from the
    side), and a piece that never touches the floor - fence rails, a lintel -
    lands far behind its wall. The hex grid says what belongs together
    (_chains). The run takes the plane of its upper-middle trusted member: art
    hanging in the air errs towards the back, so the front of the pack is right.
    """
    chains = _chains(pieces)
    targets, by_row = [], {}
    for n, chain in enumerate(chains):
        planes = sorted(f.plane() for f in chain if f.trusted) or sorted(f.plane() for f in chain)
        target = planes[-(-(len(planes) - 1) * 7 // 10)]             # ceil(0.7 (n - 1))
        # A wall stands on its hexes: real faces are within half a unit of the line
        # through them. Art that says otherwise is not a wall face at all (the
        # wrecked cars of the Den are "walls"); it goes onto the hex line itself.
        line = float(np.median([hex_line(f) for f in chain]))
        targets.append(target if abs(target - line) <= OFF_LINE else line)
        for face in chain:
            hx, hy = geometry.tile_xy(face.obj.tile)
            by_row.setdefault((face.along_u, hy if face.along_u else hx), set()).add(n)
    # Stretches of one wall line with a gap between them (a gate, a missing piece)
    # are separate runs but stand in one plane: the longest stretch decides.
    for n in sorted(range(len(chains)), key=lambda n: -len(chains[n])):
        near = [m for row in by_row.values() if n in row for m in row if abs(targets[m] - targets[n]) <= SAME_LINE]
        targets[n] = targets[max(near, key=lambda m: len(chains[m]))]
    runs = []
    for chain, target in zip(chains, targets):
        for face in chain:
            face.move_to(target)
        runs.append(Run(chain, target))
    for piece in pieces:                         # corner: the two floor lines cross at x = cu - cv
        if len(piece) == 2:
            first, second = piece
            cu, cv = (first.c, second.c) if first.along_u else (second.c, first.c)
            split = float(np.clip(round(cu - cv), first.x_from + 1, second.x_to - 1))
            # The crossing is rarely on a pixel boundary: let each face run one column
            # past it, so that the two always meet (same pixels on screen, no slit in 3D).
            first.x_to = min(split + 1, second.x_to)
            second.x_from = max(split - 1, first.x_from)
    return runs


def beside(tile, along_u):
    """The hexes next to `tile` on a wall line through it (see _chains for the zigzag along u)."""
    if not along_u:
        return [tile + geometry.HEX_WIDTH * k for k in (-2, -1, 1, 2)]
    other_row = -geometry.HEX_WIDTH if tile % geometry.HEX_WIDTH & 1 else geometry.HEX_WIDTH
    return [tile + k for k in (-2, -1, 1, 2)] + [tile + other_row + k for k in (-1, 1)]


def line_through(tile, runs_by_tile):
    """The wall run that passes through the hexes next to `tile` (the commonest one), or None."""
    found = [runs_by_tile[key] for along_u in (True, False) for key in ((along_u, t) for t in beside(tile, along_u))
             if key in runs_by_tile]
    return max(found, key=found.count) if found else None


def fold_ends(runs):
    """Fold what sticks out past a corner onto the wall around the corner. -> the new faces

    Where a run ends at a perpendicular run, the last sprite usually overhangs
    the corner by a few columns: the end of the wall's thickness, a post, the
    side of a door frame. Left on its own plane, such a strip is a fin that
    stands out past the corner (in front of the other wall on one side of the
    crossing line, hidden behind it on the other), whereas the game simply
    paints the two sprites over each other. The strip really belongs to the
    side of the wall, so it moves onto the perpendicular plane; which sprite
    is seen there is then settled like any other overlap (resolve_overlaps).
    A run that carries on past the crossing (a T or a plus) is left alone.
    """
    extra = []
    along_u = [run for run in runs if run.along_u]
    along_v = [run for run in runs if not run.along_u]
    spans = {id(run): run.span() for run in runs}
    for mine, others in ((along_u, along_v), (along_v, along_u)):
        for run in mine:
            lo, hi = spans[id(run)]
            for other in others:
                o_lo, o_hi = spans[id(other)]
                if not (o_lo - CORNER_REACH <= run.plane <= o_hi + CORNER_REACH and lo < other.plane < hi):
                    continue
                past_hi, past_lo = hi - other.plane, other.plane - lo        # how far the run goes on beyond the crossing
                if min(past_hi, past_lo) >= FOLD_REACH:
                    continue
                high_side = past_hi < past_lo                                 # the overhang is on the + side of the axis
                # Screen x of the vertical line in which the two planes meet.
                u, v = (other.plane, run.plane) if run.along_u else (run.plane, other.plane)
                cross = proj.ground_to_px(u, v)[0]
                for face in list(run.faces):
                    if face.kind != "wall":
                        continue
                    cut = float(round(cross - face.centre[0]))
                    if not face.x_from < cut < face.x_to:
                        continue
                    # + along u is screen left, + along v is screen right. Both parts keep the
                    # column at the cut, so that they meet in 3D whatever the rounding.
                    turned = proj.V_SLOPE if run.along_u else proj.U_SLOPE
                    if high_side == run.along_u:
                        over = face.part(face.x_from, min(cut + 1, face.x_to), turned)
                        face.x_from = cut
                    else:
                        over = face.part(max(cut - 1, face.x_from), face.x_to, turned)
                        face.x_to = cut
                    over.c = 0.0
                    over.move_to(other.plane)
                    over.run = other
                    extra.append(over)
    for over in extra:                          # only now: a folded strip is not folded again
        over.run.faces.append(over)
    return extra


def resolve_overlaps(faces):
    """Give every pixel of a wall plane to one face: the one the game draws last.

    Neighbouring wall sprites overlap by a few columns and the game paints them
    in hex order. In 3D they lie in the same plane, where a depth buffer cannot
    order them (it flickers). Two faces of one plane share a 3D point exactly
    where they share a screen pixel, so the game's painting can be replayed per
    plane, and each face keeps only the pixels it still owns at the end.
    (Doors and other sheets on a wall stand a skin in front of it: things.trim.)
    """
    groups = {}
    for face in faces:
        if face.run is not None and face.kind == "wall":
            groups.setdefault((face.run.along_u, round(face.run.plane, 4)), []).append(face)
    for group in groups.values():
        if len(group) < 2:
            continue
        boxes = [(f,) + f.pixels() for f in sorted(group, key=lambda f: f.order)]
        x0 = min(x for _, _, x, _ in boxes)
        y0 = min(y for _, _, _, y in boxes)
        x1 = max(x + a.shape[1] for _, a, x, _ in boxes)
        y1 = max(y + a.shape[0] for _, a, _, y in boxes)
        owner = np.full((y1 - y0, x1 - x0), -1, np.int32)
        window = lambda a, x, y: owner[y - y0:y - y0 + a.shape[0], x - x0:x - x0 + a.shape[1]]
        for n, (_, opaque, x, y) in enumerate(boxes):
            window(opaque, x, y)[opaque] = n
        for n, (face, opaque, x, y) in enumerate(boxes):
            mine = opaque & (window(opaque, x, y) == n)
            if mine.sum() != opaque.sum():
                face.mask = mine


def solid_runs(texture, z_bottom, max_gap=2):
    """Column ranges [(from, to)] of an un-sheared face that stand in the way.

    A column is open when it has a person-sized hole: PASS_HEIGHT of empty
    pixels somewhere between the floor and HEAD_ROOM (a doorway under its
    lintel, the gap in a ruin; a threshold or low rubble does not count as
    closed, a window or the space between fence rails does not count as open).
    Open stretches of a pixel or two are closed.
    """
    alpha = texture[..., 3] > 0
    height, width = alpha.shape
    # body[k] = the face's pixels k px above the floor line, for k < HEAD_ROOM.
    rows = height - 1 - (np.arange(int(HEAD_ROOM * proj.HPX)) - int(round(z_bottom * proj.HPX)))
    body = np.zeros((len(rows), width), bool)
    inside = (rows >= 0) & (rows < height)
    body[inside] = alpha[rows[inside]]
    need = int(PASS_HEIGHT * proj.HPX)
    run = np.zeros(width, int)
    longest = np.zeros(width, int)
    for row in body:                                            # longest empty run per column
        run = np.where(row, 0, run + 1)
        longest = np.maximum(longest, run)
    solid = alpha.any(axis=0) & (longest < need)
    runs, start, gap = [], None, 0
    for i, on in enumerate(list(solid) + [False] * (max_gap + 1)):
        if on:
            start, gap = (i if start is None else start), 0
        elif start is not None:
            gap += 1
            if gap > max_gap:
                runs.append((start, i - gap + 1))
                start = None
    return runs
