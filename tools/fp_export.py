#!/usr/bin/env python3
"""Export Fallout 2 maps for the first-person viewer.

    python3 tools/fp_export.py --game YOUR_GAME_FOLDER kladwtwn
    python3 tools/fp_export.py --featured                (the maps of the viewer's menu, tools/fp/catalog.py)
    python3 tools/fp_export.py denbus1.map --elev 1 --out viewer/data/denbus1-up

Writes scene.json, tiles.png, light.png and sprites<n>.png into the output directory
(default viewer/data/<name>, or <name>.<elev> for a non-default elevation)
and lists the map in viewer/data/index.json. Missing interface art is generated
automatically. Start `python tools/serve.py`, then open the address it prints.
`python tools/fp/catalog.py` optionally adds thumbnails with Node and Chrome.
"""
import argparse
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)

from f2lib import GameFiles, MapFile  # noqa: E402
from f2lib.gamepath import GamePathError, resolve_game  # noqa: E402
from fp import catalog, hud  # noqa: E402
from fp.scene import SceneBuilder  # noqa: E402

MIPS = 4 / 3                    # a full mip chain adds a third


def export(gf, source, elevation=None, out=None):
    name = os.path.splitext(os.path.basename(source))[0].lower()
    if os.path.isfile(source):                                  # a map file outside the game tree
        with open(source, "rb") as f:
            game_map = MapFile.from_bytes(f.read(), gf)
    else:
        game_map = name
    builder = SceneBuilder(gf, game_map, elevation)
    default = builder.elevation == builder.default_elevation
    out = out or os.path.join(catalog.DATA, name if default else f"{name}.{builder.elevation}")
    scene = builder.export(out)

    tiles, pages = scene["tiles"], scene["pages"]
    size = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out))
    cell = tiles["res"] + 2 * tiles["margin"]
    gpu = (len(tiles["cells"]) * cell * cell + sum(p["size"][0] * p["size"][1] for p in pages)) * 4 * MIPS
    print(f"{name} elevation {builder.elevation} \"{scene['title']}\" -> {os.path.relpath(out, ROOT)} "
          f"({size / 1e6:.1f} MB on disk, about {gpu / 1e6:.0f} MB of textures on the GPU)")
    print(f"  tiles {len(tiles['cells'])} in {tiles['size']}, "
          f"sprite pages {[p['size'] for p in pages]}, sprites {len(scene['sprites'])}")
    print(f"  wall quads {len(scene['walls'])}, billboards {len(scene['boards'])}, "
          f"decals {len(scene['decals'])}, critters {len(scene['critters'])}")
    if builder.clipped_tiles:
        print(f"  tiles larger than their square, clipped: {', '.join(builder.clipped_tiles)}")
    print(f"  wall classes (FRMs):    {scene['wallClasses']['frms']}")
    print(f"  wall classes (objects): {scene['wallClasses']['objects']}")
    print(f"  doors, scenery, items:  {scene['shapes']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("maps", nargs="*", metavar="map", help="map name (kladwtwn), file name (kladwtwn.map) or path")
    parser.add_argument("--featured", action="store_true", help="export the maps of the viewer's menu")
    parser.add_argument("--elev", type=int, help="elevation 0..2 (default: the elevation the map is entered on)")
    parser.add_argument("--out", help="output directory (one map only)")
    parser.add_argument("--overlay", help="mod data directory laid over the game tree (its art, protos and maps win)")
    parser.add_argument("--game", help="Fallout 2 installation or unpacked folder (or set FALLOUT2_DIR)")
    args = parser.parse_args()
    maps = args.maps + (list(catalog.FEATURED) if args.featured else [])
    if not maps or (args.out and len(maps) > 1):
        parser.error("name a map (or --featured); --out takes exactly one map")

    try:
        gf = GameFiles(base=resolve_game(args.game), overlay=args.overlay)
    except GamePathError as error:
        parser.exit(2, f"{error}\n")
    hud.ensure(gf)
    for source in maps:
        export(gf, source, args.elev, args.out)
    catalog.write_index()                                       # keep the viewer's menu current


if __name__ == "__main__":
    main()
