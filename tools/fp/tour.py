"""A fixed tour of first-person viewpoints, for judging the look and for before / after pairs.

    python3 tools/fp/tour.py TAG [--maps kladwtwn,denbus1] [--only street,alley] [--look] [--mobile]
                                 [--base http://127.0.0.1:8000/] [--query "&light=night"]
    python3 tools/fp/tour.py TAG --views run/fp-v2-walls/views.json     (other viewpoints, see below)
    python3 tools/fp/tour.py TAG --orbit kladwtwn:bed:65,87:2.5 ...     (eight views around a hex)
    python3 tools/fp/tour.py --pair BEFORE AFTER [--maps ...] [--only ...] [--look] [--mobile] [--views ...]

Writes run/fp-look/TAG/<map>-<view>.png at 1280x720 (and <map>-<view>-m.png at
phone size with --mobile), then contact sheets sheet-<map>[-m]-<n>.png. --pair
puts the same views of two tags side by side (pair-<map>-<view>[-m].png in AFTER).
--look takes the views the presentation is judged by (LOOK): the same for the retro
and the smooth picture, --query "&retro=1" and "&retro=0".
A --views file replaces the tour: {map: [[name, u, v, yaw, pitch], ...]} with
the eye's ground position (not a hex), so that it may stand where no one can
walk; run/fp-v2-walls/ holds the views the walls were judged by (rooms towards
each wall, each side of a building, corners, wall tops, doorways).
--orbit MAP:NAME:HX,HY[:RADIUS[:HEIGHT]] walks round a thing instead: eight views from RADIUS
units away (default 2.5), every 45 degrees, looking at HEIGHT (default 0.5) above the hex, as
<map>-<name>-<0..7>.png and one sheet orbit-<map>-<name>.png. A solid thing must keep its
shape all the way round; view 0 looks the way the game's camera does.
The viewer server (python tools/serve.py) must be running.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tools"))
OUT = os.path.join(ROOT, "run", "fp-look")
PHONE = "844x390"

# view: (name, hx, hy, yaw, pitch) or (name, hx, hy, (look-at hx, hy, height)); yaw None = as the map is entered
TOUR = {
    "kladwtwn": [
        ("spawn", 75, 125, None, 0),
        ("street", 109, 101, 76, 0),
        ("front", 97, 113, 83, -2),
        ("corner", 95, 125, 21, -3),
        ("npc", 95, 120, 70, -10),
        ("face", 81, 115, (78, 113, 1.0)),
        ("trader", 120, 90, (117, 89, 1.0)),
        ("room", 86, 114, 218, -4),
        ("stills", 83, 118, 75, 1),
        ("ceiling", 86, 114, 200, 20),
        ("doorway", 91, 113, 265, 0),
        ("alley", 92, 99, 30, 0),
        ("window", 100, 97, 0, 5),
        ("grazing", 97, 126, 304, 0),
        ("pen", 78, 126, (85, 137, 0.5)),
        ("barrels", 93, 74, (99, 75, 0.5)),
        ("edge", 30, 125, 90, 0),
        ("far", 112, 162, 10, 0),
    ],
    "denbus1": [
        ("spawn", 95, 119, None, 0),
        ("street", 100, 100, 200, 0),
        ("crowd", 74, 92, (78, 86, 0.9)),
        ("guard", 78, 86, (78, 82, 1.0)),
        ("trader", 65, 90, (62, 88, 1.0)),
        ("fence", 62, 62, 262, 0),
        ("wrecks", 142, 122, 300, -3),
        ("doorway", 104, 118, 245, 0),
        ("barrel", 100, 114, (100, 118, 0.5)),
    ],
    "arvillag": [
        ("spawn", 117, 102, None, 0),
        ("start", 113, 132, 0, 3),
        ("tent", 103, 97, (100, 100, 0.9)),
        ("elder", 115, 98, (115, 94, 1.0)),
        ("garden", 86, 98, 60, -5),
        ("pen", 75, 72, (62, 68, 0.6)),
        ("villager", 108, 113, (112, 111, 1.0)),
        ("trees", 150, 118, 110, 0),
    ],
    "vault13": [
        ("spawn", 95, 85, 180, 0),
        ("corridor", 99, 96, 0, 0),
        ("gruthar", 95, 77, (95, 73, 1.0)),
        ("doc", 84, 69, (84, 65, 1.0)),
    ],
    "newr1": [
        ("virgin", 105, 121, 330, 0),
        ("catspaw", 105, 121, 90, 0),
        ("fence", 105, 121, 210, 0),
    ],
    "vctydwtn": [
        ("street", 117, 120, 300, 0),
        ("park", 117, 120, 200, 0),
    ],
    "arcaves": [
        ("spawn", 106, 144, None, 0),
    ],
}

# --look: the views the presentation (retro / smooth, light, field of view) is judged by.
LOOK = {
    "kladwtwn": ["spawn", "street", "front", "corner", "face", "room", "ceiling", "doorway", "alley", "far"],
    "denbus1": ["spawn", "street", "crowd", "doorway", "barrel"],
    "arvillag": ["start", "tent", "elder", "garden"],
    "vault13": ["corridor", "gruthar", "doc"],
    "newr1": ["virgin", "catspaw"],
    "vctydwtn": ["street", "park"],
    "arcaves": ["spawn"],
}


ORBITS = {}         # map: [name] of the orbits asked for


def shoot(tag, maps, only, mobile, base, query):
    out = os.path.join(OUT, tag)
    os.makedirs(out, exist_ok=True)
    suffix = "-m" if mobile else ""
    for name in maps:
        views = [v for v in TOUR[name] if not only or v[0] in (only[name] if isinstance(only, dict) else only)]
        if not views:
            continue
        lines = [f"goto {base}?map={name}&anim=0&start=0{query}", "waitlog \\[fp\\] ready 30000", "wait 500"]
        for view, hx, hy, *rest in views:
            if isinstance(hx, float):                           # a ground position (--views)
                lines.append(f"eval Object.assign(fp.state, {{u: {hx}, v: {hy}, yaw: {rest[0]} * Math.PI / 180, "
                             f"pitch: {rest[1]} * Math.PI / 180, centerTile: null, noclip: true}}), 1")
            elif isinstance(rest[0], tuple):
                tx, ty, height = rest[0]
                lines.append(f"eval fp.goto({hx}, {hy}, 0), fp.lookAt({tx}, {ty}, {height}), 1")
            else:
                lines.append(f"eval fp.goto({hx}, {hy}, {'null' if rest[0] is None else rest[0]}, {rest[1]}), 1")
            lines += ["wait 350", f"shot {os.path.join(out, f'{name}-{view}{suffix}.png')}"]
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as script:
            script.write("\n".join(lines) + "\n")
        command = ["node", os.path.join(ROOT, "tools", "webtest.mjs"), "--timeout", "240000",
                   "--size", PHONE if mobile else "1280x720"] + (["--mobile"] if mobile else [])
        result = subprocess.run(command + [script.name], capture_output=True, text=True)
        os.unlink(script.name)
        for line in result.stdout.splitlines():
            if "rror" in line or "EXCEPTION" in line or "TIMEOUT" in line:
                print(line)
        if result.returncode:
            raise SystemExit(f"{name}: webtest failed ({result.returncode})\n{result.stdout[-2000:]}")
        if ORBITS:
            for view in ORBITS.get(name, ()):
                orbit_sheet(out, name, view, suffix)
        else:
            sheets(out, name, [v[0] for v in views], suffix)
        print(f"{name}{suffix}: {len(views)} views -> {os.path.relpath(out, ROOT)}")


EYE = 1.15          # the viewer's eye height (viewer/fp.js)


def orbit(spec):
    """'map:name:hx,hy[:radius[:height]]' -> (map, [(view, u, v, yaw, pitch)] * 8)."""
    from fp import proj
    name, view, at, *rest = spec.split(":")
    hx, hy = map(int, at.split(","))
    radius, height = (float(rest[0]) if rest else 2.5), (float(rest[1]) if len(rest) > 1 else 0.5)
    u, v = proj.px_to_ground(*proj.hex_px(hy * 200 + hx))
    north = proj.delta_to_ground(0, -1)                         # up the game's screen = yaw 0
    east = (north[1], -north[0])
    views = []
    for n in range(8):
        # View 0 stands where the game's camera is (down the screen from the thing) and looks north.
        angle = math.radians(180 + 45 * n)
        du, dv = (north[0] * math.cos(angle) + east[0] * math.sin(angle), north[1] * math.cos(angle) + east[1] * math.sin(angle))
        size = math.hypot(du, dv)
        eu, ev = u + du / size * radius, v + dv / size * radius
        yaw = math.degrees(math.atan2(-(du * east[0] + dv * east[1]), -(du * north[0] + dv * north[1])))
        views.append((f"{view}-{n}", float(eu), float(ev), round(yaw, 1), round(math.degrees(math.atan2(height - EYE, radius)), 1)))
    return name, views


def orbit_sheet(out, name, view, suffix, width=480):
    images = [Image.open(os.path.join(out, f"{name}-{view}-{n}{suffix}.png")).convert("RGB") for n in range(8)]
    height = width * images[0].height // images[0].width
    sheet = Image.new("RGB", (4 * width, 2 * height))
    for n, image in enumerate(images):
        sheet.paste(image.resize((width, height), Image.LANCZOS), (n % 4 * width, n // 4 * height))
    sheet.save(os.path.join(out, f"orbit-{name}-{view}{suffix}.png"))


def sheets(out, name, views, suffix, per_sheet=6, width=640):
    """Contact sheets, 2 columns: enough to judge composition; open the single shots for detail."""
    for n in range(0, len(views), per_sheet):
        images = [Image.open(os.path.join(out, f"{name}-{v}{suffix}.png")).convert("RGB") for v in views[n:n + per_sheet]]
        height = width * images[0].height // images[0].width
        sheet = Image.new("RGB", (2 * width, height * ((len(images) + 1) // 2)))
        for i, image in enumerate(images):
            sheet.paste(image.resize((width, height), Image.LANCZOS), (i % 2 * width, i // 2 * height))
        sheet.save(os.path.join(out, f"sheet-{name}{suffix}-{n // per_sheet}.png"))


def pair(before, after, maps, only, suffix=""):
    for name in maps:
        for view in (v[0] for v in TOUR[name]):
            paths = [os.path.join(OUT, tag, f"{name}-{view}{suffix}.png") for tag in (before, after)]
            if (only and view not in (only[name] if isinstance(only, dict) else only)) or not all(map(os.path.exists, paths)):
                continue
            a, b = (Image.open(p).convert("RGB") for p in paths)
            if suffix:                                          # phone captures are 3 pixels to the CSS pixel
                a, b = (image.resize((image.width // 2, image.height // 2), Image.LANCZOS) for image in (a, b))
            both = Image.new("RGB", (a.width + b.width + 8, max(a.height, b.height)), (255, 255, 255))
            both.paste(a, (0, 0))
            both.paste(b, (a.width + 8, 0))
            both.save(os.path.join(OUT, after, f"pair-{name}-{view}{suffix}.png"))
            print(f"pair-{name}-{view}{suffix}.png")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tag", nargs="?")
    parser.add_argument("--pair", nargs=2, metavar=("BEFORE", "AFTER"))
    parser.add_argument("--maps", default="", help="map names, comma separated (default: all of the tour)")
    parser.add_argument("--views", help="JSON file of viewpoints to use instead of the tour")
    parser.add_argument("--orbit", nargs="+", metavar="MAP:NAME:HX,HY[:RADIUS[:HEIGHT]]", help="eight views around a hex")
    parser.add_argument("--only", default="", help="view names, comma separated")
    parser.add_argument("--look", action="store_true", help="the views of LOOK only")
    parser.add_argument("--mobile", action="store_true")
    parser.add_argument("--base", default="http://127.0.0.1:8000/")
    parser.add_argument("--query", default="", help="extra URL parameters")
    args = parser.parse_args()
    if args.views:
        TOUR.clear()
        TOUR.update({name: [(view, float(u), float(v), yaw, pitch) for view, u, v, yaw, pitch in rows]
                     for name, rows in json.load(open(args.views)).items()})
    if args.orbit:
        TOUR.clear()
        for name, views in map(orbit, args.orbit):
            TOUR.setdefault(name, []).extend(views)
            ORBITS.setdefault(name, []).append(views[0][0][:-2])
    maps = [m for m in args.maps.split(",") if m in TOUR] if args.maps else list(TOUR)
    only = set(filter(None, args.only.split(",")))
    if args.look:
        maps, only = [m for m in maps if m in LOOK], LOOK
    if args.pair:
        pair(*args.pair, maps, only, "-m" if args.mobile else "")
    elif args.tag:
        shoot(args.tag, maps, only, args.mobile, args.base, args.query)
    else:
        parser.error("give a TAG or --pair BEFORE AFTER")


if __name__ == "__main__":
    main()
