# First-person viewer for Fallout 2 maps (unofficial)

Explore Fallout 2 maps at eye level in a browser. A Python exporter reads your own
copy of the game and builds scenes for a small WebGL 2 viewer. You can walk around,
look at objects, change the lighting, and switch to isometric or overhead views.
Combat, dialogue, inventory, and game scripts are not simulated.

**No game data is included.** You need your own legally bought, English-language
copy of Fallout 2. Textures, maps, fonts, and descriptions are generated locally
from that copy. Do not upload generated files to this repository or a public server.

This is an unofficial fan project. It is not made, endorsed or supported by Bethesda
Softworks, ZeniMax Media, Interplay or anyone else who holds rights in Fallout.
Fallout, Fallout 2, Fallout 3 and all related names, characters, places and art
belong to their owners.

## Requirements

- Python 3.10 or newer, with support for virtual environments.
- An English Fallout 2 installation containing `master.dat`, `critter.dat`, and
  `patch000.dat`, or an already extracted game-data tree. Archive names are
  case-insensitive.
- About 1.3 GB of free space for the extracted game and featured scenes.
- A browser that supports WebGL 2.

The exporter and viewer do not require a game engine, Node.js, or a compiler.
The optional capture tools have additional requirements described below.

## Install and export

This repository is private. Clone it with a GitHub account that has access; Git
must already be authenticated with that account. If you cannot open the repository
while signed in, ask the owner for access first.

Open a terminal in the folder where you want to keep the viewer. These commands
use the macOS shell and require Git:

```sh
git clone https://github.com/Apolotary/fallout2-first-person.git
cd fallout2-first-person
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Run the next block, then paste the path to your Fallout 2 installation folder or
extracted game-data folder at the prompt and press Enter. Enter the path as plain
text, without surrounding quotes or shell escapes; spaces are handled for you.
Keep the game outside this repository's generated `game/` folder.

```sh
printf 'Fallout 2 folder: '
IFS= read -r GAME_DIR
python tools/fp_export.py --game "${GAME_DIR:?Enter your Fallout 2 folder before exporting}" --featured
```

The prompt must not be left blank. This command exports the twelve featured maps.
For an installation, the first run also extracts the archives and may take a few
minutes.

The featured selection includes Klamath, New Reno, Arroyo, Vault City, Vault 13,
the Den, Modoc, and Gecko. Each exported map goes into `viewer/data/`; the interface
bar and its fonts go into `viewer/hud/`. Missing menu thumbnails are optional and
do not prevent maps from loading.

When given an installation, the exporter extracts its three archives in order
(`master.dat`, `critter.dat`, then `patch000.dat`) into the ignored `game/` folder.
It remembers the selected game folder inside `game/`, so subsequent exports can
omit `--game`. An existing extracted tree is read in place. The source game folder
is not modified.

Installation extraction uses those three archives only. It does not apply extra
patch archives or loose-file mods in the installation. The local cache is
`game/data/`, and the remembered source is `game/.source.json`; both stay ignored.

You can use `FALLOUT2_DIR` instead of `--game`. Selection precedence is `--game`,
then `FALLOUT2_DIR`, then the remembered folder. Individual map names are accepted
as positional arguments; available options are described by the exporter's help.

## Run

Start the local server:

```sh
python tools/serve.py --port 8765
```

Open <http://localhost:8765/> and choose a map. Keep the terminal open while you
use the viewer; press Ctrl+C there to stop it. Port 8765 is used in this guide;
the server's default port is 8000.

The server listens only on this computer by default and serves only `viewer/`.
Its `--lan` option allows connections from other devices on your network and prints
the address in the terminal. Use that option only on a trusted network. On a phone,
landscape orientation leaves more room for the scene and touch controls. Real-phone
use has not been verified for this release.

## Controls

- W/S or Up/Down: forward/back; A/D: sidestep; Left/Right: turn; Shift: run.
- Click the scene to look with the mouse; E examines an object; Tab opens the map.
- T changes daylight; P changes pixel rendering; H toggles the interface bar.
- M cycles first-person, isometric, and overhead views.
- Touch: left thumb moves, right thumb looks, a short tap examines an object.

See [all controls and URL options](docs/controls.md).

## Verification status

This hobby project was developed on macOS on Apple Silicon with the English GOG
release and desktop Chrome. A fresh copy was tested on 2026-10-09 with Python
3.14.6, NumPy 2.5.3, and Pillow 12.3.0. All twelve featured maps exported from the
English GOG installation.
The remembered-folder and environment-variable selections worked; repeated exports
and exports from an already extracted tree were identical. The original game
files and release source files stayed unchanged.

The local server delivered every generated scene asset correctly. Desktop Chrome
loaded the twelve-map menu and rendered Klamath with its interface bar and no
console errors. This was a smoke check of one rendered map, not a full playthrough.
Exact dependency versions are in `requirements-tested.txt`.

Windows, Linux, Steam and Epic data, other game languages, Safari, Firefox, and a
real phone have not been tested. Only the twelve featured maps are covered by the
release export check; a current full-map export has not been verified.

## Developers

[How it works](docs/how-it-works.md) explains the exporter and renderer.
`tools/fp/catalog.py` can make menu thumbnails; `shots.py` and `tour.py` capture
scripted views; `capture.py` records camera moves. These optional helpers were
developed for macOS and require Node.js 22 or newer and Chrome; video capture also
requires ffmpeg. They need the viewer server to be running, and write their
outputs into ignored folders. They are not part of the installation check above.

Keep generated data out of commits. `game/`, `viewer/data/`, `viewer/hud/`, `run/`,
and image files are ignored. A source-only repository is intentional.

## Remove

Delete this repository folder to remove the viewer, its virtual environment, its
local extracted game copy, and exported scenes. Your original game remains where
it was. Pip may retain downloaded packages in its normal cache. The viewer stores
display preferences in the browser's site storage; clear site data for the address
and port you used to remove those preferences.

## License and credits

The project is free and non-commercial. The code uses the
[Sustainable Use License 1.0](LICENSE). It includes modified routines derived from
[fallout2-ce](https://github.com/alexbatalov/fallout2-ce), whose license is preserved
in [LICENSE-fallout2-ce.md](LICENSE-fallout2-ce.md). See [NOTICE.md](NOTICE.md) for
attribution and modification details.

The repository contains no data files of any Fallout game: no art, maps, sound,
text tables, or executables. Everything derived from your game is produced on your
computer from your own copy. Please do not share those files here or elsewhere.
