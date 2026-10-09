"""Texture atlas: shelf packing with padding, identical images stored once."""
import hashlib
import os

import numpy as np
from PIL import Image

EXTRUDE = 4             # every image's edge pixels are repeated this far outwards, alpha included: a wall
                        # texture that is opaque up to its edge stays opaque there in the first mip levels,
                        # so the seams between neighbouring wall quads stay shut at a distance
PAD = 2 * EXTRUDE + 2   # distance between neighbours' own pixels (nearest sampling never leaves an image)
PAGE_WIDTH = 2048
MAX_HEIGHT = 4096       # phones: no page larger than 4096 in either direction


def save_png(path, rgba):
    """Write an RGBA image premultiplied and as small as PNG gets; returns the file size.

    The game's art has at most 255 colours and on / off alpha, so the file is a
    palette image with one transparent entry, a third of the size of 32-bit
    RGBA. Premultiplied means for such art: transparent pixels are black. The
    viewer filters these textures as premultiplied colour (render.js), so
    nothing has to be grown into the transparent surroundings of a sprite to
    keep its edges clean.
    """
    rgba = np.ascontiguousarray(rgba, dtype=np.uint8).copy()
    rgba[..., :3] = (rgba[..., :3].astype(np.uint16) * rgba[..., 3:] + 127) // 255
    colours, index = np.unique(rgba.view(np.uint32), return_inverse=True)    # alpha is the top byte: transparent = 0 sorts first
    if len(colours) <= 256 and np.isin(colours >> 24, (0, 255)).all():
        image = Image.fromarray(index.reshape(rgba.shape[:2]).astype(np.uint8))
        image.putpalette(colours.view(np.uint8).reshape(-1, 4)[:, :3].tobytes())
        image.save(path, optimize=True, **({"transparency": 0} if colours[0] == 0 else {}))
    else:                                                                    # not the game's palette: as it is
        Image.fromarray(rgba).save(path, optimize=True)
    return os.path.getsize(path)


class Atlas:
    """Collect RGBA images, then `pack()`; `rect(id)` gives (page, x, y, w, h)."""

    def __init__(self, page_width=PAGE_WIDTH, max_height=MAX_HEIGHT, pad=PAD):
        self.page_width = page_width
        self.max_height = max_height
        self.pad = pad
        self.images = []
        self._by_hash = {}
        self._rects = None
        self.pages = []

    def add(self, rgba):
        rgba = np.ascontiguousarray(rgba, dtype=np.uint8)
        key = (rgba.shape, hashlib.md5(rgba.tobytes()).digest())
        index = self._by_hash.get(key)
        if index is None:
            index = self._by_hash[key] = len(self.images)
            self.images.append(rgba)
        return index

    def pack(self):
        pad = self.pad
        order = sorted(range(len(self.images)), key=lambda i: -self.images[i].shape[0])
        self._rects = [None] * len(self.images)
        page, x, y, shelf = 0, pad, pad, 0
        heights = [0]
        for i in order:
            h, w = self.images[i].shape[:2]
            if w + 2 * pad > self.page_width or h + 2 * pad > self.max_height:
                raise ValueError(f"sprite {w}x{h} does not fit an atlas page")
            if x + w + pad > self.page_width:                  # next shelf
                x, y, shelf = pad, y + shelf + pad, 0
            if y + h + pad > self.max_height:                  # next page
                page, x, y, shelf = page + 1, pad, pad, 0
                heights.append(0)
            self._rects[i] = (page, x, y, w, h)
            x += w + pad
            shelf = max(shelf, h)
            heights[page] = max(heights[page], y + h + pad)
        self.pages = []
        for p, height in enumerate(heights):
            canvas = np.zeros((max(height, 1), self.page_width, 4), np.uint8)
            for i, rect in enumerate(self._rects):
                if rect[0] == p:
                    _, rx, ry, w, h = rect
                    e = EXTRUDE
                    canvas[ry - e:ry + h + e, rx - e:rx + w + e] = np.pad(self.images[i], ((e, e), (e, e), (0, 0)), mode="edge")
            used = max((r[1] + r[3] + pad for r in self._rects if r[0] == p), default=1)
            self.pages.append(canvas[:, :used])
        return self

    def rect(self, index):
        return self._rects[index]

    def save(self, directory, prefix):
        """Write <prefix><n>.png files; returns [{"image", "size", "bytes"}] for the scene file."""
        entries = []
        for n, page in enumerate(self.pages):
            name = f"{prefix}{n}.png"
            size = save_png(f"{directory}/{name}", page)
            entries.append({"image": name, "size": [page.shape[1], page.shape[0]], "bytes": size})
        return entries
