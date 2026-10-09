#!/usr/bin/env python3
"""The Fallout 2 interface bar for the first-person viewer, from the game's own art.

    python3 tools/fp/hud.py            (once; again only if the game data changes)

Reads art/intrface/iface.frm, sattkbup.frm, numbers.frm and font1.aaf / font3.aaf
from the unpacked game (tools/f2lib) and writes into viewer/hud/:

    iface.png   the bar, 640 x 99, as the game shows it with nothing in hand: the item
                button's blank plate laid over the SINGLE / BURST placeholder that is
                painted into iface.frm, and both counters dark (the art has the sample
                digits 036 and -258 painted in; the viewer has no hit points to show)
    font1.png   the display monitor's font (font 101) and
    font3.png   the 16-pixel capitals, as white glyphs whose alpha is the game's
                intensity (0..7), one row each
    hud.json    where things are on the bar (the game's own numbers, interface.cc and
                display_monitor.cc of fallout2-ce) and the glyph table of both fonts

viewer/hud.js draws the bar from these.
"""
import argparse
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)

from f2lib import GameFiles  # noqa: E402
from f2lib.gamepath import GamePathError, resolve_game  # noqa: E402
from f2lib.frm import Frm  # noqa: E402
from fp import VIEWER  # noqa: E402

OUT = os.path.join(VIEWER, "hud")

# interface.cc / display_monitor.cc (fallout2-ce)
ITEM_BUTTON = (267, 26)                 # sattkbup.frm, 188 x 67
COUNTERS = [(473, 40), (473, 75)]       # hit points, armor class: a 6-pixel sign and three 9-pixel digits, 17 high
SIGN_W, DIGIT_W, BLANK_SIGN_X = 6, 9, 114       # numbers.frm: the "plus" sign is an empty piece of the display
MONITOR = (23, 24, 167, 60)             # the display monitor's text area
MONITOR_COLOUR = 992                    # RGB555 index into the colour table: the monitor's green
FONTS = {"font1": "font1.aaf", "font3": "font3.aaf"}


def frame(gf, name):
    return Frm.from_bytes(gf.read(f"art/intrface/{name}.frm")).frame().array()


def bar(gf):
    pixels = frame(gf, "iface").copy()
    plate = frame(gf, "sattkbup")
    x, y = ITEM_BUTTON
    pixels[y:y + plate.shape[0], x:x + plate.shape[1]] = np.where(plate > 0, plate, pixels[y:y + plate.shape[0], x:x + plate.shape[1]])
    numbers = frame(gf, "numbers")
    blank = numbers[:, BLANK_SIGN_X:BLANK_SIGN_X + SIGN_W]
    width = SIGN_W + 3 * DIGIT_W
    dark = np.tile(blank, (1, width // SIGN_W + 1))[:, :width]
    for x, y in COUNTERS:
        pixels[y:y + dark.shape[0], x:x + width] = dark
    rgba = gf.palette.rgba[pixels].copy()
    rgba[..., 3] = 255                                          # the bar has no holes
    return Image.fromarray(rgba)


def font(gf, name):
    """-> (image, metrics): the glyphs side by side, bottoms on one line as the game draws them."""
    data = gf.read(name)
    magic, height, letter, space, line = struct.unpack_from(">4s4h", data, 0)
    if magic != b"AAFF":
        raise ValueError(f"{name} is not an AAF font")
    table = [struct.unpack_from(">hhi", data, 12 + 8 * code) for code in range(256)]
    base = 12 + 8 * 256
    glyphs, columns, x = {}, [], 0
    for code, (w, h, offset) in enumerate(table):
        if w <= 0 or h <= 0 or code == 32:
            continue
        cell = np.zeros((height, w), np.uint8)
        cell[height - h:, :] = np.frombuffer(data, np.uint8, w * h, base + offset).reshape(h, w)
        glyphs[code] = [x, w]
        columns.append(cell)
        x += w
    levels = np.concatenate(columns, axis=1)
    rgba = np.full(levels.shape + (4,), 255, np.uint8)
    rgba[..., 3] = np.round(np.minimum(levels, 7) / 7 * 255)      # 7 and above: the full colour (color.cc, blend tables)
    return Image.fromarray(rgba), {"height": height, "letter": letter, "space": space, "line": height + line,
                                           "glyphs": glyphs}


def generate(gf):
    os.makedirs(OUT, exist_ok=True)
    image = bar(gf)
    image.save(os.path.join(OUT, "iface.png"), optimize=True)
    layout = {
        "size": list(image.size),
        "monitor": list(MONITOR),
        "monitorColour": [int(c) for c in gf.palette.rgb[gf.palette.lut[MONITOR_COLOUR]]],
        "plate": [*ITEM_BUTTON, *frame(gf, "sattkbup").shape[::-1]],
        "fonts": {},
    }
    for key, name in FONTS.items():
        sheet, metrics = font(gf, name)
        sheet.save(os.path.join(OUT, key + ".png"), optimize=True)
        layout["fonts"][key] = metrics
    with open(os.path.join(OUT, "hud.json"), "w") as f:
        json.dump(layout, f, separators=(",", ":"))
    for name in sorted(os.listdir(OUT)):
        print(f"{os.path.relpath(os.path.join(OUT, name), ROOT)}  {os.path.getsize(os.path.join(OUT, name))} bytes")


def ensure(gf):
    """Build the interface once, or repair an interrupted generation."""
    if not all(os.path.isfile(os.path.join(OUT, name)) for name in
               ("hud.json", "iface.png", "font1.png", "font3.png")):
        generate(gf)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", help="Fallout 2 installation or unpacked folder (or set FALLOUT2_DIR)")
    args = parser.parse_args()
    try:
        gf = GameFiles(base=resolve_game(args.game))
    except GamePathError as error:
        parser.exit(2, f"{error}\n")
    generate(gf)


if __name__ == "__main__":
    main()
