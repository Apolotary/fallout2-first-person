"""Underground: the rock that the caves and vaults are cut into.

The game shows a cave from above with its lid off. Where the camera looks at
a rock face there is a picture of one (a wall piece); on the near side of every
passage there is nothing but the black top of the rock, as floor tiles and as
wall pieces painted in the same black, and beyond that the map is empty. From
inside that is a room with painted screens along two of its sides and a void
behind them. So underground maps get the rock itself (first person only):

    mass      everything that is not open: `solid`, a grid of CELLS per unit.
              Open is the floor that has a tile brighter than the black filler
              and a disc round every hex that can be walked to. The wall pieces
              then say where rock is: behind a picture of rock or of a wall (up
              to the rock or the black that lies behind it), and in front of a
              picture of the rock's black top, which the game stands at the far
              edge of the rock it shows the top of. What lies right in front of
              a picture that can be seen is open again, whatever the tiles say.
    faces     the outline of the open ground (`loops`), drawn up to the height
              of the roofs: it leans back and bulges a little, never towards
              the open side. The viewer stands them up and lays a ceiling on.
    material  one small tile that repeats (`texture`), cut from the map's own
              pictures of rock faces.

Wall pieces that only show the rock's black top (`is_top`) are left out in
first person: the rock stands there now.
"""
import math

import numpy as np
from PIL import Image, ImageDraw

CELLS = 8               # per unit
SIZE = 100 * CELLS
DARK = 40               # mean brightness (0..255) below which a floor tile or a wall's picture is the rock's black top
WALK = 0.36             # units round a hex centre that are open if the hex can be walked to
FRONT = 0.5             # units in front of a wall's picture that are open, if open ground is near ...
SEEN_FROM = 1.0         # ... namely within this distance of it
BEHIND = 1.5            # units behind a wall's picture within which rock must lie for the gap to fill up
TOP = 0.75              # units of rock in front of a picture of its top, at least
SKIN = 0.03             # units between a wall's picture and the rock behind it
SMALL = 4.0             # units^2: less rock than this in one piece is a dark floor tile, not rock
SMOOTH = 0.75           # units: how far a corner of the outline may stand out and still be a step of the grid ...
STEPS = 1.3             # ... between edges no longer than this (the floor tiles are a unit wide)
PIECE = 1.1             # units: about how long one face is
DENT = 0.1              # units that a corner of the outline steps back, at most
LEAN = (0.12, 0.4)      # units that a rock face leans back up to the roofs
BULGE = 0.14            # units that it may bulge, half way up
TILE = 128              # texels of the material's side
FADE = 10               # rows over which one strip of it fades into the next
TEXELS = 48             # of it per unit of rock: as fine as the game's pictures


def is_top(image):
    """Is a wall's picture (rgba) nothing but the black top of the rock?"""
    opaque = image[..., 3] > 0
    return bool(opaque.any() and image[..., :3][opaque].mean() < DARK)


def cell(point):
    """Index into the grid of the cell that holds a ground point."""
    return tuple(np.clip(np.floor(np.array(point)[::-1] * CELLS).astype(int), 0, SIZE - 1))


def solid(lit, walked, faces, tops):
    """The rock: (rock, clear), both bool (SIZE, SIZE) [v, u] in cells; clear = where no rock may ever be.

    lit     100x100 bool: squares with a floor tile that is not the black filler
    walked  [(u, v)]: centres of the hexes that can be walked to
    faces   [(ua, va, ub, vb, thick)]: wall pictures, a on the left for whoever looks at one;
            the wall is `thick` deep behind it
    tops    the same for the pictures of the rock's top
    """
    stamp = Image.new("L", (SIZE, SIZE), 0)
    draw = ImageDraw.Draw(stamp)
    for u, v in walked:
        draw.ellipse([(u - WALK) * CELLS, (v - WALK) * CELLS, (u + WALK) * CELLS, (v + WALK) * CELLS], fill=255)
    clear = np.asarray(stamp) > 0
    rock = ~(np.kron(lit, np.ones((CELLS, CELLS), bool)) | clear)
    step = 0.5 / CELLS

    def rays(face, start, reach, forward):
        """Cells along rays from every point of a face: (rows, columns) of shape (points, steps)."""
        ua, va, ub, vb = face[:4]
        length = math.hypot(ub - ua, vb - va) or 1e-9
        normal = np.array([(vb - va) / length, (ua - ub) / length]) * (1 if forward else -1)    # forward: towards whoever looks at it
        along = np.array([ua, va]) + np.outer(np.arange(step / 2, length, step) / length, [ub - ua, vb - va])
        points = along[:, None, :] + normal * np.arange(start, reach, step)[None, :, None]
        index = np.floor(points * CELLS).astype(int)
        inside = ((index >= 0) & (index < SIZE)).all(axis=-1)
        return index[..., 1].clip(0, SIZE - 1), index[..., 0].clip(0, SIZE - 1), inside

    def fill(face, start, reach, forward, least=0.0):
        """Rock along the rays of a face up to the first rock, at least `least` far; never across walked ground."""
        rows, columns, inside = rays(face, start, reach, forward)
        if not rows.size:
            return
        hit, walk = before[rows, columns] | ~inside, clear[rows, columns] & inside
        free = np.cumsum(walk, axis=1) == 0                         # the ray has not met walked ground yet
        first = np.where(hit.any(axis=1), hit.argmax(axis=1), int(least / step))
        wanted = free & (np.arange(rows.shape[1])[None, :] < first[:, None])
        wanted &= (hit.any(axis=1) | (least > 0))[:, None]
        rock[rows[wanted & inside], columns[wanted & inside]] = True

    before = rock.copy()
    for face in tops:                                               # from beyond the discs of the hexes behind it
        fill(face, WALK / 2, BEHIND, True, TOP)
    before = rock.copy()
    for face in faces:
        fill(face, face[4] + SKIN + step, BEHIND, False)
    for face in faces:                                              # seen from open ground: nothing stands in front of it
        rows, columns, inside = rays(face, step, SEEN_FROM, True)
        if rows.size:
            seen = (~before[rows, columns] & inside).any(axis=1)
            near = rays(face, 0.0, FRONT, True)
            keep = seen[:, None] & near[2]
            rock[near[0][keep], near[1][keep]] = False
            clear = clear.copy() if not clear.flags.writeable else clear
            clear[near[0][keep], near[1][keep]] = True
    # A small island of "rock" is a dark tile in somebody's floor. Flood every piece once: 1 = not yet looked at.
    pieces = Image.fromarray(rock.astype(np.uint8))
    while True:
        todo = np.flatnonzero(np.asarray(pieces).ravel() == 1)
        if not len(todo):
            return rock, clear
        ImageDraw.floodfill(pieces, (int(todo[0] % SIZE), int(todo[0] // SIZE)), 2)
        piece = np.asarray(pieces) == 2
        if piece.sum() < SMALL * CELLS * CELLS:
            rock[piece] = False
        pieces.paste(3, mask=Image.fromarray(piece))


def _outline(rock):
    """The grid edges between rock and open ground as closed loops of grid corners [(x, y)],
    the rock on the left of the way round."""
    padded = np.pad(rock, 1, constant_values=True)                 # beyond the map is rock
    step = {}
    h, w = rock.shape
    ys, xs = np.nonzero(~rock)
    for y, x in zip(ys.tolist(), xs.tolist()):                      # the four edges of every open cell
        if padded[y, x + 1]:
            step.setdefault((x + 1, y), []).append((x, y))          # rock above: the edge runs towards -x
        if padded[y + 2, x + 1]:
            step.setdefault((x, y + 1), []).append((x + 1, y + 1))
        if padded[y + 1, x]:
            step.setdefault((x, y), []).append((x, y + 1))
        if padded[y + 1, x + 2]:
            step.setdefault((x + 1, y + 1), []).append((x + 1, y))
    loops = []
    while step:
        start = next(iter(step))
        loop, at = [start], start
        while True:
            ends = step[at]
            # Where two loops touch in a corner, turn towards the open cell this edge came along.
            following = ends.pop(0) if len(ends) == 1 or len(loop) < 2 else \
                ends.pop(min(range(len(ends)), key=lambda n: _turn(loop[-2], at, ends[n])))
            if not ends:
                del step[at]
            if following == start:
                break
            loop.append(following)
            at = following
        loops.append(loop)
    return loops


def _turn(a, b, c):
    """Cross product of the steps a-b and b-c: least for the sharpest turn to the right."""
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])


def _smoothed(loop):
    """A loop of grid corners without the steps of the grid: (n, 2), in cells.

    A corner goes if it lies on a straight line, or if it is the outer corner of
    a step: the rock juts out at it between two short edges, and at both its
    neighbours the open ground does. What is left of a flight of steps is the
    slope through its inner corners. That only ever takes rock away, so it puts
    none in a walker's way, and pillars and long walls keep their corners. Long
    edges are then cut into pieces, so that the faces can wander.
    """
    points = np.array(loop, float)
    while len(points) > 4:
        a, b = points - np.roll(points, 1, axis=0), np.roll(points, -1, axis=0) - points
        juts = a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]            # > 0: the rock's corner, < 0: the open ground's
        short = np.maximum(np.hypot(*a.T), np.hypot(*b.T)) <= STEPS * CELLS
        step = (juts > 0) & short & (juts <= SMOOTH * CELLS * np.hypot(*(a + b).T)) & (np.roll(juts, 1) < 0) & (np.roll(juts, -1) < 0)
        if not (step | (juts == 0)).any():
            break
        points = points[~(step | (juts == 0))]
    out = []
    for n, at in enumerate(points):
        edge = points[(n + 1) % len(points)] - at
        pieces = max(1, int(round(np.hypot(*edge) / (PIECE * CELLS))))
        out += [at + edge * k / pieces for k in range(pieces)]
    return np.array(out)


def _noise(points, scale, seed):
    """Smooth pseudo-random numbers 0..1 for ground points (n, 2): a lattice of hashes, blended."""
    p = points / scale
    cell, t = np.floor(p), p - np.floor(p)
    t = t * t * (3 - 2 * t)
    hashed = lambda i, j: np.modf(np.sin((cell[:, 0] + i) * 127.1 + (cell[:, 1] + j) * 311.7 + seed) * 43758.5453)[0] % 1.0
    return (hashed(0, 0) * (1 - t[:, 0]) + hashed(1, 0) * t[:, 0]) * (1 - t[:, 1]) + (hashed(0, 1) * (1 - t[:, 0]) + hashed(1, 1) * t[:, 0]) * t[:, 1]


def loops(rock):
    """The rock faces: [[u, v, u half way up, v, u at the top, v, ...]], one closed loop per piece
    of outline, the rock on the left of the way round.

    Every corner of the smoothed outline steps back a little and gets its place half way up and
    at the top: further back along the bisector of its two edges, by amounts that wander along
    the wall. Away from the open side only: nothing may come in front of a wall's picture or
    into a walker's way.
    """
    out = []
    for loop in _outline(rock):
        ring = _smoothed(loop) / CELLS if len(loop) >= 8 else ()
        if len(ring) < 3:
            continue
        before, after = np.roll(ring, 1, axis=0), np.roll(ring, -1, axis=0)
        unit = lambda vectors: vectors / np.maximum(np.hypot(*vectors.T), 1e-9)[:, None]
        a, b = unit(ring - before), unit(after - ring)
        left = unit(np.stack([-(a[:, 1] + b[:, 1]), a[:, 0] + b[:, 0]], axis=1))      # into the rock ...
        left[np.hypot(*(a + b).T) < 1e-6] = 0                                          # ... (a hairpin has no side)
        sharp = np.clip(1 + (a * b).sum(axis=1), 0.35, 1)                              # less at sharp corners: they would cross
        foot = ring + left * (DENT * _noise(ring, 0.7, 4.0) * sharp)[:, None]
        lean = (LEAN[0] + (LEAN[1] - LEAN[0]) * _noise(ring, 2.3, 1.0)) * sharp
        bulge = BULGE * _noise(ring, 0.9, 7.0) * sharp
        rows = np.concatenate([foot, foot + left * (lean / 2 + bulge)[:, None], foot + left * lean[:, None]], axis=1)
        out.append([round(float(c), 3) for c in rows.ravel()])
    return out


def texture(pictures, samples, seed=3):
    """The material: (TILE, TILE, 4) uint8 that repeats.

    pictures: the map's pictures of rock faces (rgba, un-sheared). The tile is made of strips of
    them side by side, the way the game builds a rock face out of pieces, two strips to a column:
    of every picture the middle of the rows that it fills from side to side (under its upper
    edge, over the boulders at its foot). The lowest rows of a strip fade into the first rows of
    the one below it - of the upper one again at the tile's lower edge, so that the tile also
    repeats downwards - and every strip is brought to the brightness of all of them.
    Without enough such pictures: `clouds` in the colours `samples`.
    """
    rng = np.random.default_rng(seed)
    rows, strips = TILE // 2, []
    for image in pictures:
        whole = np.flatnonzero((image[..., 3] > 0).all(axis=1))
        if len(whole) and image.shape[1] >= 8:
            run = max(np.split(whole, np.flatnonzero(np.diff(whole) > 1) + 1), key=len)
            if len(run) >= rows + FADE:
                first = run[0] + (len(run) - rows - FADE) // 2
                strips.append(image[first:first + rows + FADE, :, :3].astype(float))
    if len(strips) < 4:
        return clouds(samples, seed)
    level = np.mean([strip.mean() for strip in strips])
    strips = [np.clip(strip * min(level / max(strip.mean(), 1.0), 1.6), 0, 255) for strip in strips]
    weight = ((np.arange(FADE) + 1) / (FADE + 1))[:, None, None]
    tile = np.zeros((TILE, TILE, 4), np.uint8)
    x = 0
    while x < TILE:
        pair = [strips[n] for n in rng.choice(len(strips), 2, replace=False)]
        width = min(pair[0].shape[1], pair[1].shape[1], TILE - x)
        for n, (strip, below) in enumerate((pair, pair[::-1])):
            body = strip[FADE:, :width].copy()
            body[rows - FADE:] = body[rows - FADE:] * (1 - weight) + below[:FADE, :width] * weight
            tile[n * rows:(n + 1) * rows, x:x + width, :3] = body
        x += width
    tile[..., 3] = 255
    return tile


def clouds(samples, seed=3):
    """A tile of cloud noise in the colours of `samples` ((n, 3) uint8), as often as they are there.

    Four octaves on a lattice that wraps round, drawn out along one diagonal like strata, give
    every texel a rank; the samples, sorted by brightness, give the colour of that rank.
    """
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:TILE, 0:TILE] / TILE
    cloud = np.zeros((TILE, TILE))
    for octave, (fx, fy) in enumerate(((3, 2), (7, 4), (13, 9), (29, 17))):
        lattice = rng.random((fy, fx))
        px, py = (x + 0.35 * y) * fx, y * fy                       # sheared: strata dip
        i, j, tx, ty = np.floor(px).astype(int), np.floor(py).astype(int), px % 1, py % 1
        tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
        at = lambda dj, di: lattice[(j + dj) % fy, (i + di) % fx]
        cloud += ((at(0, 0) * (1 - tx) + at(0, 1) * tx) * (1 - ty) + (at(1, 0) * (1 - tx) + at(1, 1) * tx) * ty) / 2 ** octave
    cloud += rng.random((TILE, TILE)) * 0.3                        # grain
    rank = cloud.ravel().argsort().argsort() / (TILE * TILE - 1)
    samples = np.asarray(samples, np.uint8)
    ordered = samples[samples.astype(int).sum(axis=1).argsort()]
    colours = ordered[(len(ordered) * (0.05 + 0.9 * rank)).astype(int)]
    return np.concatenate([colours.reshape(TILE, TILE, 3), np.full((TILE, TILE, 1), 255, np.uint8)], axis=2)
