"""Tents: a pitched hide roof on leaning hide walls, in place of a slab of roof tiles on upright ones.

The map builds a tent like a house: wall pieces round a rectangle, the near ones
painted from outside and the far ones from inside, and roof tiles 96 px above
the floor. But the roof tiles are a picture of a ridge roof, and the walls
under it lean in. As a flat slab on four upright sheets that reads as a
market stall with a painting on top. A tent is found by its material (wall
protos of leather under one patch of roof) and becomes one form (render.js):

    roof      two slopes that meet in a ridge along u or along v. Its picture
              fixes it up to a shift along the camera's ray (`Roof`); the tent's
              footprint fixes that: the roof is centred over it.
    walls     from the lines the wall pieces stand on up to the eaves: they lean
              as much as the roof is narrower than the footprint. Under each end
              of the ridge an upright gable.
    pictures  all by projection from the game's camera, so the doorway is simply
              where the walls' picture has a hole: the roof and the near walls
              show the tent as the game does with roofs on, the far walls from
              inside as with roofs off. What no picture shows is cut from the
              longest stretch of near wall without a hole: the outside of the
              far walls, the two corners where the near walls' picture stops
              short; and every inside is its outside, dark.

`find` and `build` are what scene.py calls.
"""
import numpy as np

from f2lib import map as mapfile

from . import boxes, proj, walls
from .forms import facing, row

MIN_WALLS = 4           # hide pieces under one patch of roof, at least
REACH = 1.0             # units round a patch of roof within which a wall belongs to it
SHADE = 16              # colour levels: darker roof pixels are the shade it throws on the doorway
MAX_RISE = 1.6          # units: the ridge above the eaves, at most
RIDGE_STEP = 2          # px between the ridge lines tried
MIN_FIT = 0.8           # share of roof picture and roof model that must agree
MIN_EAVES, MAX_EAVES = 0.6, proj.ROOF_PX / proj.HPX     # units: where eaves may be
INSIDE = 0.55           # how much darker a tent is inside
OVERHANG = 0.2          # units by which the roof reaches beyond the outline it was fitted to
WHOLE = 0.8             # share of a wall's height (a roof's length) that its picture fills where it has no hole
SKIRT = 0.7             # units in front of a wall's foot where its hem and the dirt against it lie on the floor
SEEN = 0.05             # a roof slope turned this much towards the camera shows its own pixels


def picture(faces, rgba_of):
    """Wall faces as the game paints them: (rgba, x, y) with the world pixel of the top-left corner."""
    parts = [(face,) + face.pixels() for face in sorted(faces, key=lambda face: face.order)]
    x0, y0 = min(x for _, _, x, _ in parts), min(y for _, _, _, y in parts)
    x1 = max(x + opaque.shape[1] for _, opaque, x, _ in parts)
    y1 = max(y + opaque.shape[0] for _, opaque, _, y in parts)
    out = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
    for face, opaque, x, y in parts:
        c0, c1 = face.columns()
        out[y - y0:y - y0 + opaque.shape[0], x - x0:x - x0 + opaque.shape[1]][opaque] = rgba_of(face)[:, c0:c1][opaque]
    return out, x0, y0


def roof_picture(squares, tile_rgba):
    """The roof tiles of some squares as the game paints them: (rgba, x, y)."""
    tiles = [(tile_rgba(square),) + proj.ground_to_px(square % 100, square // 100) for square in sorted(squares)]
    spots = [(rgba, int(x) - 48, int(y - proj.ROOF_PX)) for rgba, x, y in tiles]      # a tile's top corner is its pixel (48, 0)
    x0, y0 = min(x for _, x, _ in spots), min(y for _, _, y in spots)
    out = np.zeros((max(y + rgba.shape[0] for rgba, _, y in spots) - y0, max(x + rgba.shape[1] for rgba, x, _ in spots) - x0, 4), np.uint8)
    for rgba, x, y in spots:
        out[y - y0:y - y0 + rgba.shape[0], x - x0:x - x0 + rgba.shape[1]][rgba[..., 3] > 0] = rgba[rgba[..., 3] > 0]
    return out, x0, y0


class Roof:
    """A ridge roof read from its picture.

    A line along the ridge has screen slope m (3/4 along v, -1/4 along u), so
    s = y - m x is the same all along it, and s = S0 + px * a - HPX * z for a
    point at `a` across the ridge and height z: the two eaves and the ridge
    are three values of s. Likewise t = y - m' x = T0 + px' * b - HPX * z with
    the other slope, b running along the ridge. At either end of the roof its
    outline is a line of constant b that climbs from the eaves to the ridge, so
    there t falls by HPX * rise, in proportion to the way up the slope:

        t = t_max - HPX * rise * up(s)            the near end
        t = t_min + HPX * rise * (1 - up(s))      the far end

    with up(s) = 0 at the eaves .. 1 at the ridge. s_near and s_far are the
    picture's own outline (the near eaves, and the far eaves or - if the far
    slope is turned away from the camera - the ridge). For every ridge line
    s_ridge between them the two ends give rise, t_min and t_max by least
    squares; the ridge is where they fit best. `fit` = how much of picture and
    model agree then.

    That leaves the eaves' height open, which slides the whole roof along the
    camera's ray; `place` sets it.
    """

    def __init__(self, alpha, x, y):
        ys, xs = np.nonzero(alpha)
        px, py = xs + x + 0.5, ys + y + 0.5
        gy, gx = np.mgrid[0:alpha.shape[0], 0:alpha.shape[1]]
        self.fit, self.rise = 0.0, -1.0
        for along_v in (True, False):
            best = np.inf
            m, across = (proj.V_SLOPE, proj.U_SLOPE) if along_v else (proj.U_SLOPE, proj.V_SLOPE)
            s, t = py - m * px, py - across * px
            # Pixel-wide strips along the ridge. The eaves are the outermost ones that the picture
            # fills from end to end (the rim of a hide is ragged), and the outline at both ends of
            # the roof is the extreme t of every strip.
            strips = np.arange(int(s.min()), int(s.max()) + 1)
            strip = (s - strips[0]).astype(int)
            order = np.lexsort((t, strip))
            first = np.searchsorted(strip[order], np.arange(len(strips)))
            count = np.diff(np.append(first, len(order)))
            ends = [t[order][np.minimum(first + (count * share).astype(int), len(order) - 1)] for share in (0.02, 0.98)]
            full = count >= WHOLE * np.median(count)
            s_far, s_near = strips[full][0] + 0.0, strips[full][-1] + 1.0
            for s_ridge in np.arange(s_far, s_near - RIDGE_STEP, RIDGE_STEP):
                middle = strips + 0.5
                up = np.where(middle >= s_ridge, (s_near - middle) / (s_near - s_ridge), (middle - s_far) / max(s_ridge - s_far, 1e-6))
                up = np.clip(up, 0, 1)[full]
                # t_far = B - L up, t_near = A - L up: unknowns A, B, L (= HPX * rise).
                rows = np.concatenate([np.stack([np.zeros_like(up), np.ones_like(up), -up], axis=1),
                                       np.stack([np.ones_like(up), np.zeros_like(up), -up], axis=1)])
                wanted = np.concatenate([ends[0][full], ends[1][full]])
                (a, b, lift), *_ = np.linalg.lstsq(rows, wanted, rcond=None)
                error = np.abs(rows @ (a, b, lift) - wanted).mean()
                if error < best and 0 <= lift <= MAX_RISE * proj.HPX:
                    best, found = error, (along_v, lift / proj.HPX, (s_near, s_ridge, s_far), (b - lift, a))
            # Across the ridge the ends of a roof are its eaves, straight lines: no rise. The ridge runs the other way.
            if best < np.inf and found[1] > self.rise:
                self.along_v, self.rise, self.s, self.t = found
        if self.rise >= 0:
            m, across = (proj.V_SLOPE, proj.U_SLOPE) if self.along_v else (proj.U_SLOPE, proj.V_SLOPE)
            (s_near, s_ridge, s_far), (t_min, t_max), lift = self.s, self.t, self.rise * proj.HPX
            s, t = gy + y + 0.5 - m * (gx + x + 0.5), gy + y + 0.5 - across * (gx + x + 0.5)
            up = np.where(s >= s_ridge, (s_near - s) / (s_near - s_ridge), (s - s_far) / max(s_ridge - s_far, 1e-6))
            model = (s >= s_far) & (s <= s_near) & (t <= t_max - lift * up) & (t >= t_min + lift * (1 - up))
            self.fit = (model & alpha).sum() / max((model | alpha).sum(), 1)

    def place(self, centre):
        """Put the roof over ground point `centre`: -> its corners {name: (u, v, z)}.

        Raising the eaves by dz moves every point of the roof HPX * dz / px across and
        along (the camera's ray); the height is the one that brings the middle of the
        roof nearest to `centre`.
        """
        m, across = (proj.V_SLOPE, proj.U_SLOPE) if self.along_v else (proj.U_SLOPE, proj.V_SLOPE)
        # y - m x = (Oy - m Ox) + u (SQ_U.y - m SQ_U.x) + v (SQ_V.y - m SQ_V.x) - HPX z, and one of the two brackets is 0.
        coeff = lambda slope: (proj.SQ_U[1] - slope * proj.SQ_U[0]) + (proj.SQ_V[1] - slope * proj.SQ_V[0])
        zero = lambda slope: proj.ORIGIN[1] - slope * proj.ORIGIN[0]
        (s_near, s_ridge, s_far), (t_min, t_max) = self.s, self.t
        lift = self.rise * proj.HPX

        def corners(eaves):
            a = lambda s, z: (s - zero(m) + proj.HPX * z) / coeff(m)
            b = lambda t, z: (t - zero(across) + proj.HPX * z) / coeff(across)
            top = eaves + self.rise
            # Without a far slope in the picture the far eaves are as far from the ridge as the near ones.
            far = a(s_far, eaves) if s_ridge - s_far >= RIDGE_STEP else 2 * a(s_ridge, top) - a(s_near, eaves)
            return {"E1": (a(s_near, eaves), b(t_min + lift, eaves), eaves), "E2": (a(s_near, eaves), b(t_max, eaves), eaves),
                    "R1": (a(s_ridge, top), b(t_min, top), top), "R2": (a(s_ridge, top), b(t_max - lift, top), top),
                    "F1": (far, b(t_min + lift, eaves), eaves), "F2": (far, b(t_max, eaves), eaves)}

        low = corners(0.0)
        middle = np.mean([low[name][:2] for name in ("E1", "E2", "F1", "F2")], axis=0)
        wanted = np.array(centre if self.along_v else centre[::-1]) - middle
        ray = np.array([proj.HPX / coeff(m), proj.HPX / coeff(across)])
        eaves = float(np.clip(wanted @ ray / (ray @ ray), MIN_EAVES, MAX_EAVES))
        # Across / along -> u / v.
        return {name: ((a, b, z) if self.along_v else (b, a, z)) for name, (a, b, z) in corners(eaves).items()}


def _foot(cuts):
    """Where a wall of hide meets the floor: the plane coordinate of the line under most of its columns.

    The line walls.py stands a wall on is the one under its lowest pixels, and for a
    tent those are the hem that lies on the ground and the dirt heaped against it.
    """
    planes = []
    for face in (cut.face for cut in cuts):
        x, lower, _ = walls._edges(face.alpha, face.left, face.top)
        mine = (x >= face.x_from) & (x < face.x_to)
        planes += list(face.run.plane + (lower[mine] - face.slope * x[mine] - face.c) / boxes.depth_px(face.along_u))
    return float(np.median(planes))


def find(cuts, roof, is_hide):
    """Tents: [(roof squares, far cuts, near cuts, (u_lo, v_lo, u_hi, v_hi))].

    cuts: boxes.Cut of every wall face; roof: 100x100 bool; is_hide(obj): is the wall piece of hide?
    The four numbers are the lines its far and near walls stand on: its footprint.
    """
    labels = boxes._labels(roof)
    tents = []
    for label in range(1, labels.max() + 1):
        vs, us = np.nonzero(labels == label)
        under = [cut for cut in cuts if cut.face.kind == "wall" and cut.face.run is not None
                 and us.min() - REACH <= (cut.a[0] + cut.b[0]) / 2 <= us.max() + 1 + REACH
                 and vs.min() - REACH <= (cut.a[1] + cut.b[1]) / 2 <= vs.max() + 1 + REACH]
        hide = [cut for cut in under if is_hide(cut.face.obj)]
        if len(hide) < MIN_WALLS or 2 * len(hide) < len(under):
            continue
        sides = {}                                          # (along u, near): its cuts
        for along_u in (False, True):
            planes = [cut.face.run.plane for cut in hide if cut.face.along_u == along_u]
            for cut in hide:
                if cut.face.along_u == along_u:
                    sides.setdefault((along_u, cut.face.run.plane > (min(planes) + max(planes)) / 2), []).append(cut)
        if len(sides) == 4:
            foot = [_foot(sides[key]) for key in ((False, False), (True, False), (False, True), (True, True))]
            # What hangs on its walls (ropes, painted signs) is part of their picture.
            runs = {id(cut.face.run): key for key, side in sides.items() for cut in side}
            for cut in cuts:
                if cut.face.kind == "panel" and id(cut.face.run) in runs and cut.face.obj.flags & mapfile.OBJECT_NO_BLOCK:
                    sides[runs[id(cut.face.run)]].append(cut)
            tents.append(((vs * 100 + us).tolist(), sides[False, False] + sides[True, False], sides[False, True] + sides[True, True], foot))
    return tents


class Side:
    """One wall of a tent: the quad from its foot a-b up to the eaves d-c (d over a, c over b).
    at(along, up): the point `along` of the way from a to b and `up` of the way to the eaves."""

    def __init__(self, a, b, c, d):
        self.a, self.b, self.c, self.d = a, b, c, d
        self.length = float(np.linalg.norm(b - a))

    def at(self, along, up):
        return (self.a + (self.b - self.a) * along) * (1 - up) + (self.d + (self.c - self.d) * along) * up

    def part(self, start, end):
        return Side(self.at(start, 0), self.at(end, 0), self.at(end, 1), self.at(start, 1))

    def corners(self):
        return [self.a, self.b, self.c, self.d]

    def covered(self, rgba, x, y, steps=48):
        """How much of the wall its picture fills, at `steps` places along it (hem and eaves aside)."""
        points = np.array([[self.at(along, up) for up in np.linspace(0.15, 0.9, 12)] for along in (np.arange(steps) + 0.5) / steps])
        px, py = proj.ground_to_px(points[..., 0], points[..., 1], points[..., 2])
        i, j = np.floor(px - x).astype(int), np.floor(py - y).astype(int)
        inside = (i >= 0) & (j >= 0) & (i < rgba.shape[1]) & (j < rgba.shape[0])
        return (inside & (rgba[np.clip(j, 0, rgba.shape[0] - 1), np.clip(i, 0, rgba.shape[1] - 1), 3] > 0)).mean(axis=1)


def _longest(flags):
    """(start, end) of the longest run of True."""
    best, start = (0, 0), None
    for n, on in enumerate(list(flags) + [False]):
        if on and start is None:
            start = n
        elif not on and start is not None:
            best, start = max(best, (start, n), key=lambda run: run[1] - run[0]), None
    return best


def build(squares, far, near, foot, rgba_of, tile_rgba):
    """One tent -> [(rgba, x, y, faces)] (three pictures: roof, near walls, far walls), or None if
    its roof is no ridge roof."""
    u_lo, v_lo, u_hi, v_hi = foot
    tiles, tx, ty = roof_picture(squares, tile_rgba)
    roof = Roof((tiles[..., 3] > 0) & (tiles[..., :3].max(axis=2) > SHADE), tx, ty)
    if roof.fit < MIN_FIT:
        return None
    top = roof.place(((u_lo + u_hi) / 2, (v_lo + v_hi) / 2))
    E1, E2, R1, R2, F1, F2 = (np.array(top[name]) for name in ("E1", "E2", "R1", "R2", "F1", "F2"))
    # The feet of the long walls: N under the near eaves, G under the far ones; 1 = the far end, 2 = the near one.
    if roof.along_v:
        N1, N2, G1, G2 = (u_hi, v_lo, 0.0), (u_hi, v_hi, 0.0), (u_lo, v_lo, 0.0), (u_lo, v_hi, 0.0)
    else:
        N1, N2, G1, G2 = (u_lo, v_hi, 0.0), (u_hi, v_hi, 0.0), (u_lo, v_lo, 0.0), (u_hi, v_lo, 0.0)
    N1, N2, G1, G2 = (np.array(p) for p in (N1, N2, G1, G2))
    middle = (N1 + N2 + G1 + G2) / 4
    walls_near, nx, ny = picture([cut.face for cut in near], rgba_of)
    walls_far, fx, fy = picture([cut.face for cut in far], rgba_of)
    faces = {"roof": [], "near": [], "far": []}

    def face(group, points, shows=None, inside=True, up=False):
        """A face seen from outside and (inside) the same seen from inside, darker. shows: the
        points whose pixels its corners have, if not their own."""
        outward = (0, 0, 1) if up else (np.mean(points, axis=0) - middle) * (1, 1, 0)
        ordered, normal = facing(list(points), outward)
        if shows is not None and ordered[0] is not points[0]:       # turned round: so are the points it shows
            shows = list(shows)[::-1]
        faces[group].append(row(0, normal, ordered, shows))
        if inside:
            faces[group].append(row(INSIDE, -normal, ordered[::-1], None if shows is None else list(shows)[::-1]))

    # The roof, a little larger all round than its outline was read: the ragged rim of the picture
    # hangs over the walls. A slope that is turned away from the camera shows what the other one does.
    along = (R2 - R1) / np.linalg.norm(R2 - R1) * OVERHANG
    down = lambda eaves, ridge: (eaves - ridge) / np.linalg.norm(eaves - ridge) * OVERHANG
    near_slope = [E1 + down(E1, R1) - along, E2 + down(E2, R2) + along, R2 + along, R1 - along]
    far_slope = [F1 + down(F1, R1) - along, F2 + down(F2, R2) + along, R2 + along, R1 - along]
    face("roof", near_slope, up=True)
    seen = facing(far_slope, (0, 0, 1))[1] @ np.array(proj.TOWARD_CAMERA) >= SEEN
    face("roof", far_slope, None if seen else near_slope, up=True)

    # The near walls show their own pixels, as far as their picture goes: at the two corners of
    # the tent that are its outline for the camera it stops short. The longest stretch of wall
    # without a hole is the hide that everything else is cut from: those ends, and the outside
    # of the far walls.
    near_long, near_end = Side(N1, N2, E2, E1), Side(N2, G2, F2, E2)
    spans, hide = {}, None
    for side in (near_long, near_end):
        cover = side.covered(walls_near, nx, ny)
        some = np.flatnonzero(cover >= 0.5)
        spans[side] = (some[0] / len(cover), (some[-1] + 1) / len(cover)) if len(some) else (0.0, 0.0)
        whole = np.array(_longest(cover >= WHOLE)) / len(cover)
        if hide is None or (whole[1] - whole[0]) * side.length > hide.length:
            hide = side.part(*whole)
    if hide.length < 0.5:
        return None

    def lent(side, start=0.0, end=1.0, top=1.0, **how):
        """A stretch of a wall in the hide's pixels, as much of the hide as it is long."""
        share = min(1.0, (end - start) * side.length / hide.length)
        part, source = side.part(start, end), hide.part(0.0, share)
        face("near", [part.at(0, 0), part.at(1, 0), part.at(1, top), part.at(0, top)],
             [source.at(0, 0), source.at(1, 0), source.at(1, min(top, 0.95)), source.at(0, min(top, 0.95))], **how)

    for side in (near_long, near_end):
        start, end = spans[side]
        face("near", side.part(start, end).corners())
        if start > 0.02:
            lent(side, 0.0, start)
        if end < 0.98:
            lent(side, end, 1.0)
    face("near", [E2, F2, R2])
    # The far walls, outside and inside, and their gable: what is just under the eaves of the hide.
    far_long, far_end = Side(G1, G2, F2, F1), Side(G1, N1, E1, F1)
    lent(far_long)
    lent(far_end)
    share = min(1.0, far_end.length / hide.length)
    ridge = float((R1 - F1) @ (E1 - F1) / ((E1 - F1) @ (E1 - F1)))
    face("near", [F1, E1, R1], [hide.at(0, 0.95), hide.at(share, 0.95), hide.at(share * ridge, 0.95 - (R1[2] - E1[2]) / E1[2])])
    # Inside, a skin in front of that lining, their own pixels: the game shows them when it lifts the roof.
    for wall in (far_long.corners(), far_end.corners(), [E1, F1, R1]):
        inward = facing(wall, (middle - np.mean(wall, axis=0)) * (1, 1, 0))
        faces["far"].append(row(0, inward[1], [corner + inward[1] * 0.01 for corner in inward[0]]))
    # What the walls' pictures show in front of their feet lies on the floor: outside the near
    # walls, inside the far ones.
    across, along = (N1 - G1) / np.linalg.norm(N1 - G1), (N2 - N1) / np.linalg.norm(N2 - N1)
    for group, feet in (("near", ((N1, N2, across), (N2, G2, along))), ("far", ((G1, G2, across), (G1, N1, along)))):
        for p, q, out in feet:
            strip = [p, q, q + out * SKIRT, p + out * SKIRT]
            faces[group].append(row(0, *facing([corner + (0, 0, 0.004) for corner in strip], (0, 0, 1))[::-1]))
    return [(tiles, tx, ty, faces["roof"]), (walls_near, nx, ny, faces["near"]), (walls_far, fx, fy, faces["far"])]
