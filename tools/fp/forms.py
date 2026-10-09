"""Faces of forms: what tents.py and sets.py hand to the viewer (viewer/render.js).

A form is a picture with the world pixel of its top-left corner and a list of
flat faces. A face shows the pixels that its corners land on from the game's
camera - or, where the exporter says so, the pixels of other points (the far
side of a thing takes what its near side shows). Faces are one-sided.
"""
import numpy as np


def facing(points, towards):
    """The corners in the order that is counter-clockwise for an eye on the `towards` side
    (so the order the viewer wants), and the unit normal on that side."""
    a, b, c = (np.array(p, float) for p in points[:3])
    normal = np.cross(b - a, c - a)
    if normal @ np.array(towards, float) < 0:
        points, normal = points[::-1], -normal
    return points, normal / (np.linalg.norm(normal) or 1.0)


def row(dim, normal, points, shows=None):
    """A face as the viewer takes it: [dim, normal, x y z of each corner, the same of the points
    whose pixels it shows or 0]. dim: 0 = lit like a wall .. 1 = black."""
    flat = lambda corners: [round(float(c), 3) for corner in corners for c in corner]
    return [dim, flat([normal]), flat(points), flat(shows) if shows is not None else 0]


def face(points, towards, shows=None, dim=0):
    """row() of a face seen from the `towards` side; shows: one point per corner, in the corners' order."""
    points = list(points)
    ordered, normal = facing(points, towards)
    if shows is not None and ordered[0] is not points[0]:           # turned round: so are the points it shows
        shows = list(shows)[::-1]
    return row(dim, normal, ordered, shows)
