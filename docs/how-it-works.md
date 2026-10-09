# How the viewer works

The exporter turns a Fallout 2 map into a static scene. The browser renders that
scene and moves a camera through it. It does not run the game's engine or scripts,
so quests, combat, dialogue, inventory, and changes made during play are absent.

## From game files to a scene

`tools/fp_export.py` uses `tools/f2lib` to select the user's game and read maps,
prototypes, palettes, sprite frames, and message tables. An installation is
extracted locally once; an existing extracted tree is read in place. The command
selects a map elevation, normally the elevation of its entrance, and passes it to
`tools/fp/scene.py`.

The scene builder reads floor and roof tiles, visible map objects, light sources,
and object names and descriptions. `tools/fp/proj.py` relates the game's isometric
pixels to horizontal coordinates and height. This lets the exporter infer simple
surfaces from drawings that were made for one fixed camera.

| Original map content | Exported representation |
|---|---|
| Floor and roof tiles | Square textures obtained by reversing the isometric projection |
| Recognized wall sprites | Upright textured faces with thickness, tops, and far sides |
| Doors, signs, and posters | Textured faces fitted into nearby wall planes |
| Furniture and suitable scenery | Boxes or cylinders fitted to sprite outlines |
| Other scenery and items | Sprite cards anchored at the object's map position |
| Flat objects | Decals on the floor |
| Characters | Billboards with six directions and standing animation |
| Plants | Crossed sheets where appropriate |
| Tents and selected landmarks | Simple reconstructed forms |
| Underground boundaries | Rock surfaces around and over open ground |

These are approximations. A sprite contains no picture of its hidden side, and a
single outline does not uniquely describe a solid. Unrecognized pieces remain
cards; reconstructed walls and objects can look different from some angles.
The isometric and overhead modes help compare these representations.

## Textures, lighting, and text

`atlas.py` packs sprites into texture sheets. `walls.py`, `boxes.py`, `props.py`,
`things.py`, `tents.py`, `sets.py`, and `rock.py` handle different kinds of geometry.
`light.py` produces a texture containing lamp light, daylight reach, and floor
shading. The browser combines those channels with the selected outdoor mood;
underground maps use their own ambient lighting.

Each map exports a `scene.json` plus tile, lighting, and sprite images; some maps
also have a rock texture. Names, descriptions, and examination wording are read
from the user's game. The interface bar and fonts are generated separately under
`viewer/hud/`. All of these outputs contain game material and are ignored by Git.

`catalog.py` writes `viewer/data/index.json`, which supplies the map menu. Its
featured list provides an order and short descriptions. Thumbnails are optional
captures of an already running viewer and require the developer browser tools.

## In the browser

`viewer/fp.js` loads the chosen scene, handles camera movement and collisions, and
connects the interface. `render.js` draws with WebGL 2. `geom.js` supplies projection
and grid calculations; `menu.js`, `hud.js`, and `touch.js` handle the menu, interface
bar, and touch input. `capture.js` supports externally driven frames.

Pixel rendering draws a smaller image and enlarges it with sharp edges. Smooth
rendering uses more pixels and can reduce its resolution when frames take too long.
Display preferences are stored locally by the browser. There is no game-save or
upload service.

## Serving and development

`tools/serve.py` is a Python standard-library static server restricted to `viewer/`.
It defaults to a loopback listener; `--lan` enables other devices on the same
network. The server accepts only the file types needed by the viewer and does not
provide directory browsing or write methods.

The normal export path requires only NumPy and Pillow. Optional scripted captures
use `tools/webtest.mjs`, a Node.js driver for Chrome. Capture helpers can also call
ffmpeg. Their output belongs in ignored folders, not in the repository.

The file-format and geometry code includes modified ports from fallout2-ce. See
the root `NOTICE.md` for their origin and the applicable license.
