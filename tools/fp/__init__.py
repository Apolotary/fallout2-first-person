"""First-person exporter: turns a Fallout 2 map into 3D geometry for viewer.

    proj         the game's projection constants, ground <-> pixel maps, how sprite cards stand and sort
    walls        wall sprites -> upright quads: classification, un-shearing, runs, corners, overlaps, openings
    boxes        those quads -> solid walls: thickness, tops, far sides and their material, ends, collision
    things       doors, scenery and items: wall-like sheet, sprite card or decal
    props        furniture and other deep scenery: the box or drum that first person shows instead of a card
    atlas        texture atlas packing, palette PNGs
    light        the baked light image (lamps, daylight under roofs, floor shade), shadows painted into sprites
    scene        map -> scene.json + PNGs
    catalog      the viewer's map menu: index.json and thumbnails (python3 tools/fp/catalog.py -h)
    shots        scripted viewer screenshots (python3 tools/fp/shots.py -h)
    tour         a fixed tour of first-person viewpoints, before / after pairs (python3 tools/fp/tour.py -h)

Command line: tools/fp_export.py.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The release layout wins; the fallback supports the original development layout.
VIEWER = ROOT / "viewer"
if not VIEWER.is_dir():
    VIEWER = ROOT.joinpath("web", "public", "fp")
