# Notices

## Fallout 2 Community Edition

This project contains code derived from
[Fallout 2 Community Edition (fallout2-ce)](https://github.com/alexbatalov/fallout2-ce),
read at commit `e97087b9582f37075db347a89898887320753f8b`.
fallout2-ce is offered by its author under the Sustainable Use License 1.0;
an unchanged copy of its license is in [LICENSE-fallout2-ce.md](LICENSE-fallout2-ce.md).
The derived portions remain licensed to you by the author of fallout2-ce under
that license, not by this project.

**The derived portions have been modified:** routines were ported from C++ to
Python and JavaScript, shortened, and rearranged. Knowledge of file formats and
game rules throughout `tools/` and the viewer comes from reading that source;
many comments identify the corresponding engine files.

Examples include:

| Project files | Engine source and subject |
|---|---|
| `viewer/geom.js`, `tools/f2lib/geometry.py` | `tile.cc`: hex geometry and coordinate conversion |
| `tools/f2lib/pal.py` | `cycle.cc`: animated palette ranges |
| `tools/f2lib/map.py`, `frm.py`, `pro.py` | `map.cc`, `object.cc`, `art.cc`, and related files: map, sprite, and prototype formats |
| `tools/fp/light.py` | `light.cc`: light intensity and falloff |
| `tools/fp/hud.py` | `interface.cc`, `display_monitor.cc`, `color.cc`: interface layout and font rendering |

This is an illustrative list, not a complete list of derived portions.

## Project code

Copyright (c) 2026 Apolotary.

This project's own code is offered under the same Sustainable Use License 1.0
text in [LICENSE](LICENSE).

## Game data and trademarks

No data file of any Fallout game is included. The exporter reads the user's own
copy and creates local scenes, images, fonts, and text. Those generated files are
not covered by this project's license.

This is an unofficial fan project. It is not made, endorsed or supported by Bethesda
Softworks, ZeniMax Media, Interplay or anyone else who holds rights in Fallout.
Fallout, Fallout 2, Fallout 3 and all related names, characters, places and art
belong to their owners.
