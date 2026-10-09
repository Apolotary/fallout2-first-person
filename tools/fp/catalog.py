#!/usr/bin/env python3
"""The viewer's map menu: viewer/data/index.json and one thumbnail per exported map.

    python3 tools/fp/catalog.py                  thumbnails for the maps that have none, then the index
    python3 tools/fp/catalog.py kladwtwn denbus1 (re)make these thumbnails, then the index
    python3 tools/fp/catalog.py --index          only rewrite the index

index.json = [{map, title, note, view, bytes, thumb}]: the FEATURED maps first
and in their order, then whatever else has been exported.
`title` is the game's own name for the place, "<city>: <area>": the city from
data/city.txt and the area from text/english/game/map.msg (the entries 200 + 3 *
the map's row in data/maps.txt + elevation), not the internal row name in
maps.txt ("New Reno 1"). `view` is where the menu's link starts the walk (URL
parameters of the viewer), `bytes` what a browser downloads for the map: the
images and scene.json as served by tools/serve.py.

A thumbnail (data/<map>/thumb.jpg) is a first-person capture of the running
viewer through tools/webtest.mjs. Start tools/serve.py first; --base selects
its address when using a different port. Node and Chrome are needed only
for thumbnails.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from fp import VIEWER  # noqa: E402

DATA = os.path.join(VIEWER, "data")
THUMB = (480, 270)          # 16:9; the menu shows it about 300 CSS pixels wide
SHOT = 2                    # the capture is this many times larger and scaled down: the viewer's retro picture
                            # of a 540-row page has 270 rows, so the thumbnail is that picture pixel for pixel

# name: (title, one line for the menu, the view the menu starts the map with and the thumbnail shows:
#        URL parameters of the viewer; "" = where the game enters the map, or the nearest spot
#        to there with a clear view (clearView in fp.js))
FEATURED = {
    "kladwtwn": ("Klamath: Downtown", "Trappers' town: brick houses, a corn patch, brahmin in the pen.",
                 "pos=95,125&yaw=21&pitch=-3"),
    "newr1": ("New Reno: Virgin Street", "Virgin Street at dusk: the Desperado's lights, graffiti, barrel fires.",
              "pos=105,125&yaw=335&time=dusk"),
    "arvillag": ("Arroyo: Village", "The tribe's tents around the stone monument.", "pos=113,132&yaw=0&pitch=3"),
    "artemple": ("Arroyo: Temple Entrance", "The Temple of Trials: two towers, the gate in the cliff.",
                 "pos=88,97&yaw=333&pitch=7"),
    "arcaves": ("Arroyo: Temple Foyer", "Inside the temple: stone halls underground, giant ants.", ""),
    "vctydwtn": ("Vault City: Downtown", "Clean walls, round doors, paved streets, a park.", "pos=117,120&yaw=200"),
    "vault13": ("Vault 13: Level 1", "Steel corridors under a ceiling. No sky down here.", ""),
    "denbus1": ("The Den: Businesses", "Ruined streets, car wrecks, a barrel fire.", ""),
    "modmain": ("Modoc: Main Street", "A dusty main street: plank shacks, a rusty truck, brahmin in the pen.", ""),
    "gecksetl": ("Gecko: Settlement", "Junk-built sheds and a cornfield at the edge of the desert.", ""),
    "klamall": ("Klamath: Mall", "Crates, a bare tree, chain-link fences and a billboard on the warehouse wall.",
                "pos=88,138&yaw=300&pitch=-3"),
    "v13ent": ("Vault 13: Entrance Cavern", "The entrance cavern: bare rock, almost no light.", ""),
}


def exported():
    """Names of the exported maps, FEATURED first."""
    if not os.path.isdir(DATA):
        return []
    names = sorted(n for n in os.listdir(DATA) if os.path.exists(os.path.join(DATA, n, "scene.json")))
    return [n for n in FEATURED if n in names] + [n for n in names if n not in FEATURED]


def write_index():
    os.makedirs(DATA, exist_ok=True)
    entries = []
    for name in exported():
        folder = os.path.join(DATA, name)
        with open(os.path.join(folder, "scene.json"), "rb") as f:
            raw = f.read()
        scene = json.loads(raw)
        images = [scene["tiles"], scene["light"]] + scene["pages"] + ([scene["rock"]] if scene.get("rock") else [])
        entries.append({
            "map": name,
            "title": FEATURED.get(name, (scene.get("title", name),))[0],
            "note": FEATURED.get(name, ("", "", ""))[1],
            "view": FEATURED.get(name, ("", "", ""))[2],
            "bytes": len(raw) + sum(image["bytes"] for image in images),
            "thumb": "thumb.jpg" if os.path.exists(os.path.join(folder, "thumb.jpg")) else None,
        })
    with open(os.path.join(DATA, "index.json"), "w") as f:
        json.dump(entries, f, indent=1)
    return entries


def thumbnails(names, base="http://127.0.0.1:8000/"):
    """One capture per map from its FEATURED view."""
    lines, shots = [], {}
    for name in names:
        view = FEATURED.get(name, ("", "", ""))[2]
        shots[name] = os.path.join(tempfile.gettempdir(), f"fp-thumb-{name}.png")
        lines += [f"goto {base.rstrip('/')}/?map={name}&ui=0&anim=0&start=0&retro=1&{view}",
                  "waitlog \\[fp\\] ready 30000", "wait 400", f"shot {shots[name]}"]
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as script:
        script.write("\n".join(lines) + "\n")
    size = f"{THUMB[0] * SHOT}x{THUMB[1] * SHOT}"
    result = subprocess.run(["node", os.path.join(ROOT, "tools", "webtest.mjs"), "--size", size, "--timeout",
                             str(60000 + 20000 * len(names)), script.name], capture_output=True, text=True)
    os.unlink(script.name)
    if result.returncode:
        raise SystemExit(f"thumbnails failed (is the viewer server running at --base?):\n{result.stdout[-2000:]}{result.stderr[-1000:]}")
    for name, shot in shots.items():
        image = Image.open(shot).convert("RGB").resize(THUMB, Image.LANCZOS)
        image.save(os.path.join(DATA, name, "thumb.jpg"), quality=82, optimize=True)
        os.unlink(shot)
        print(f"thumbnail {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("maps", nargs="*", help="maps to (re)make the thumbnail of (default: those without one)")
    parser.add_argument("--index", action="store_true", help="no thumbnails, only rewrite index.json")
    parser.add_argument("--base", default="http://127.0.0.1:8000/", help="viewer server URL")
    args = parser.parse_args()
    names = args.maps or [n for n in exported() if not os.path.exists(os.path.join(DATA, n, "thumb.jpg"))]
    if names and not args.index:
        thumbnails(names, args.base)
    for entry in write_index():
        print(f"  {entry['map']:10} {entry['bytes'] / 1e6:5.2f} MB  {entry['title']}{'' if entry['thumb'] else '  (no thumbnail)'}")


if __name__ == "__main__":
    main()
