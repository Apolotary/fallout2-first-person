# Controls

Choose an exported map from the menu, then click or tap its start screen. Enter or
Space also starts a loaded scene. On desktop, clicking the scene captures the
mouse for looking; Escape releases it using the browser's pointer-lock behavior.

## Keyboard and mouse

| Input | Action |
|---|---|
| W / Up, S / Down | Walk forward, backward |
| A, D | Sidestep left, right |
| Left, Right | Turn left, right |
| Shift | Run while held |
| Mouse movement after clicking | Look around |
| E or Enter | Examine the object under the crosshair |
| Tab | Toggle the map overlay |
| T | Cycle day, dusk, and night outdoors |
| P | Switch between pixel and smooth rendering |
| V | Cycle field-of-view settings |
| B | Toggle head movement while walking |
| H | Toggle the game's interface bar |
| R | Toggle roofs |
| M | Cycle first-person, isometric, and overhead views |
| Mouse wheel | Zoom in isometric or overhead view |
| F | Toggle diagnostic numbers |
| N | Toggle walking through obstacles |
| O | Compare reconstructed solids with sprite cards |

Movement keys pan the map in isometric and overhead views. Underground maps keep
their own lighting; the time-of-day control does not change them. Examination
displays exported names and descriptions; it does not start dialogue or operate
objects.

## Touch and on-screen buttons

Drag on the left half of the scene to move with the floating stick. Drag on the
right half to look around, or pan in the other views. A short stationary tap on an
object examines it. Each thumb is tracked independently.

The on-screen buttons provide run, examine, map, time of day, pixel rendering,
fullscreen, and settings. Settings control field of view, walking speed, turning
speed, head movement, and the interface bar. Fullscreen and orientation locking
depend on browser support; they may be unavailable.

## Saved settings

The viewer remembers pixel rendering, field of view, speed, turning speed, head
movement, and interface-bar visibility in browser site storage under `fp`.
Storage is separate for each address and port. A URL option overrides a remembered
setting for that visit. Changing a setting with a button or key saves the new
choice when browser storage is available.

## URL options

Append options after `?`, joined with `&`. For example,
`?map=kladwtwn&time=dusk&hud=0` opens an exported Klamath scene at dusk without
the interface bar. With no `map` option, the page displays the map menu.

| Option | Meaning |
|---|---|
| `map=name` | Folder name under `viewer/data/` |
| `pos=hx,hy` or `pos=tile` | Starting hex coordinates or tile number; otherwise use the map's entrance |
| `yaw=degrees` | Heading clockwise from the top of the game's isometric screen |
| `pitch=degrees` | Vertical look angle; positive looks up |
| `iso=1` | Start in isometric view |
| `top=1` | Start in overhead view; `iso=1` takes precedence |
| `zoom=number` | Scale in isometric or overhead view |
| `roof=0` | Hide roofs |
| `ui=0` | Hide scene overlays |
| `anim=0` | Freeze character animation |
| `time=day`, `time=dusk`, `time=night` | Outdoor lighting; default is day |
| `plan=1` | Start with the map overlay open |
| `retro=0` or `retro=1` | Smooth or pixel rendering |
| `fov=degrees` | Vertical field of view, subject to the viewer's aspect-ratio limits |
| `speed=number` | Walking-speed multiplier |
| `turn=number` | Turning-speed multiplier |
| `bob=0` or `bob=1` | Disable or enable head movement |
| `hud=0` or `hud=1` | Hide or show the interface bar |

The following options support development and scripted captures:

| Option | Meaning |
|---|---|
| `block=number` | Canvas pixels per rendered pixel in pixel mode; automatic by default |
| `capture=1` | Draw only when the capture script requests a frame |
| `eye=number` | Camera height in scene units |
| `solids=0` | Show furniture as cards and tents as walls under roof tiles |
| `proxies=1` | Show reconstructed forms in isometric view |
| `start=0` | Skip the start screen |
| `scale=number` | Fixed canvas pixels per CSS pixel |
| `nogl=1` | Exercise the unsupported-WebGL message |
| `debug=1` | Show diagnostic numbers |
| `noclip=1` | Disable movement collisions |
| `seed=number` | Seed character idle-animation timing for capture |

The visible controls are implemented in `viewer/fp.js` and `viewer/touch.js`.
Changing the viewer does not change the original game's controls or save files.
