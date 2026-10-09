// First-person walker for exported Fallout 2 maps (tools/fp_export.py).
// Without ?map= the page is the map menu (menu.js).
//
// URL parameters
//   map=<name>       directory under data/
//   pos=<hx>,<hy>    start hex (or pos=<tile>); default: the map's entering tile
//   yaw=<deg>        0 = towards the top of the game's screen ("north"), clockwise
//   pitch=<deg>      up positive
//   iso=1            the game's own camera, centred on pos like the engine centres a tile
//   top=1            straight-down debug view with walls drawn as bars
//   zoom=<n>         scale of the iso / top view (iso: 1 = one screen pixel per game pixel)
//   roof=0           hide roofs      ui=0  hide overlays      anim=0  freeze critters
//   time=day|dusk|night   light under the open sky (default day)
//   plan=1           start with the minimap open
//   retro=0|1        the picture: small and enlarged with square pixels (default), or smooth at full size
//   fov=<deg>        field of view from the top of the picture to the bottom
//   speed=<n> turn=<n>  walking speed and turning rate, as multiples of the normal ones
//   bob=1            head-bob
//   hud=0|1          the game's interface bar under the picture (hud.js; default: shown)
//                    (these six are the settings of the on-screen keys, remembered between visits;
//                    given in the URL they hold for this visit only)
//   block=<n>        retro: canvas pixels to each pixel of the picture (default: by the canvas's size)
//   capture=1        filming: the page draws nothing by itself, a script asks for every picture
//                    (capture.js, tools/fp/capture.py)
//   eye=<n>          eye height in units (to try out)
//   solids=0         furniture as sprite cards, tents as walls under roof tiles again, to compare (key O)
//   proxies=1        iso=1 only: draw what first person puts in place of walls, roofs and cards
//                    (forms); the game's picture must come out all the same
//   start=0          no start screen (scripted screenshots)
//   scale=<n>        canvas pixels per CSS pixel, fixed (default: the screen's; for the smooth
//                    picture 2 at most, stepping down when frames come slowly)
//   nogl=1           behave as if the browser had no WebGL 2 (to see the message)
//
// Keys: WASD / arrows walk and turn, Shift runs, mouse looks (click first),
// E looks at what is under the crosshair, Tab minimap, T time of day, P retro / smooth
// picture, V field of view, B head-bob, H interface bar, R roofs, M first person / game view /
// top view, F numbers, N no-clip, O solids / cards.
// Touch (touch.js): left thumb walks, right thumb looks around, a tap on a thing
// looks at it; keys for run, look, minimap, time of day, the picture, fullscreen and
// the settings (field of view, speed, turning, head-bob, interface bar).

import { Proj, HEX_W, DIR_PIXELS, hexPx, hexFromPx, card } from './geom.js';
import { Renderer, MOODS, underground, RETRO_LINES } from './render.js';
import { touchControls, press } from './touch.js';
import { showMenu } from './menu.js';
import { Iface } from './hud.js';

const EYE = 1.15;             // eye height: a standing human sprite is ~1.27 units tall
// The field of view is set from the top of the picture to the bottom: ceilings are low (1.9
// units), and it is the height of the view that makes a room feel cramped or not. Sideways
// it follows from the screen's shape, within these bounds (a very wide or an upright screen).
const MAX_HFOV = 115, MIN_HFOV = 64, MAX_VFOV = 75;     // degrees
const RADIUS = 0.16;          // player radius for collisions
const PILLAR = 0.26;          // radius of a blocking hex (hexes are 0.5 apart)
const WALK = 2.4, RUN = 5.0;  // units per second
const ACCEL = 12;             // 1 / s: how fast the walking speed follows the keys
const STRIDE = 1.7;           // units walked per head-bob cycle (two steps)
const BOB = [0.012, 0.028];   // head-bob: sideways and up-down, units
const MAX_PITCH = 1.1;        // radians up or down: sprite cards do not bear being seen from above
const MOUSE_LOOK = 0.0025;    // radians per pixel of mouse travel
const TOUCH_LOOK = [0.0055, 0.0038];  // radians per CSS pixel of thumb travel, sideways and up-down: the width
                                      // of a phone turns you 3/4 round; pitch is calmer, a thumb never moves straight
const LOOK_RANGE = 14;        // how far the "looking at" label reaches
const TIMES = Object.keys(MOODS);
const FORMAT = 6;             // of scene.json (tools/fp/scene.py)
// Canvas pixels per CSS pixel. The smooth picture: at most MAX_SCALE (a phone reports 3,
// which is 2.25 times the pixels to fill and nothing one could see in this art). When
// SLOW_FRAMES more frames than not took longer than SLOW_MS, the scale steps down by
// SCALE_STEP, to 1 at the least: a fluent picture beats a sharp one. The retro picture is
// small whatever the canvas (render.js) and only enlarged onto it, so there the canvas has
// every pixel of the screen, up to RETRO_SCALE: its squares then have sharp edges.
const MAX_SCALE = 2, SCALE_STEP = 0.5, SLOW_MS = 28, SLOW_FRAMES = 40;
const RETRO_SCALE = 3;

const params = new URLSearchParams(location.search);
const flag = (name, fallback) => (params.has(name) ? params.get(name) !== '0' : fallback);
const number = (name, fallback) => (params.has(name) && isFinite(+params.get(name)) ? +params.get(name) : fallback);
const $ = (id) => document.getElementById(id);
const CAPTURE = flag('capture', false);       // filming: see capture.js

// ----------------------------------------------------------------- settings
// What a visitor may set and the page remembers (localStorage "fp"): name = the field of
// `state` and the URL parameter; [what the key says, [value, its name] ..., the default].
const SETTINGS = {
  retro: ['PIXELS', [[true, 'RETRO'], [false, 'SMOOTH']], true],
  fov: ['VIEW', [[52, 'NARROW'], [62, 'NORMAL'], [72, 'WIDE']], 62],
  speed: ['SPEED', [[0.7, 'SLOW'], [1, 'NORMAL'], [1.4, 'FAST']], 1],
  turn: ['TURNING', [[0.6, 'SLOW'], [1, 'NORMAL'], [1.6, 'FAST']], 1],
  bob: ['HEAD-BOB', [[false, 'OFF'], [true, 'ON']], false],
  hud: ['GAME BAR', [[true, 'ON'], [false, 'OFF']], true],
};
let remembered = {};
try { remembered = JSON.parse(localStorage.getItem('fp')) || {}; } catch (error) { /* private browsing: nothing is kept */ }

function setting(name) {
  const [, choices, fallback] = SETTINGS[name];
  if (params.has(name)) return typeof fallback === 'boolean' ? flag(name) : number(name, fallback);
  return choices.some(([value]) => value === remembered[name]) ? remembered[name] : fallback;
}

// The next choice of a setting (the key was pressed), remembered.
function advance(name) {
  const choices = SETTINGS[name][1];
  state[name] = choices[(choices.findIndex(([value]) => value === state[name]) + 1) % choices.length][0];
  remembered[name] = state[name];
  try { localStorage.setItem('fp', JSON.stringify(remembered)); } catch (error) { /* then until the page is left */ }
  say(`${SETTINGS[name][0][0]}${SETTINGS[name][0].slice(1).toLowerCase()}: ${settingName(name).toLowerCase()}.`);
}

function settingName(name) {
  const choice = SETTINGS[name][1].find(([value]) => value === state[name]);
  return choice ? choice[1] : String(state[name]);
}

const state = {
  mode: flag('iso', false) ? 'iso' : flag('top', false) ? 'top' : 'fp',
  u: 0, v: 0, yaw: 0, pitch: 0,
  zoom: number('zoom', 1),
  roofs: flag('roof', true),
  ui: flag('ui', true),
  anim: flag('anim', true),
  debug: flag('debug', false),
  noclip: flag('noclip', false),
  retro: setting('retro'), fov: setting('fov'), speed: setting('speed'), turn: setting('turn'), bob: setting('bob'),
  hud: setting('hud'),
  block: number('block', 0),  // retro: canvas pixels per picture pixel, 0 = by the canvas's size (render.js)
  lift: 0,                    // share of the page's height that the interface bar covers (layoutBar)
  eye: number('eye', EYE),
  time: TIMES.includes(params.get('time')) ? params.get('time') : TIMES[0],
  plan: flag('plan', false),
  options: false,             // the settings are open
  solids: flag('solids', true),
  proxies: flag('proxies', false),
  seed: number('seed', 0),    // filming: of the critters' fidgeting
  blend: null,                // filming: the light as a number, 0 = day .. 2 = night, between them a mixture
  run: false,                 // the RUN key (Shift runs while it is held)
  entered: false,             // past the start screen: input moves the player
  velocity: [0, 0],           // ground units per second
  stride: 0,                  // head-bob phase, radians
  sway: 0,                    // 0..1: how much of the head-bob shows (follows the walking speed)
  lookingAt: -1,              // index into scene.names of what the crosshair is on
  fps: 0,
  downloaded: 0,              // bytes the map took over the network
};

let scene, proj, renderer, solid, critters, pickables, caveMood;
const iface = new Iface($('iface'));      // the game's interface bar (hud.js)
let north, east;              // unit ground vectors: up / right on the game's screen

// ------------------------------------------------------------------ loading
function decode(base64, Type) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Type(bytes.buffer);
}

const mapName = params.get('map');

// One file as a Blob; onBytes(n) for every n bytes that arrive.
async function download(url, onBytes) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.body) {                           // no streams in this browser: the file arrives in one piece
    const blob = await response.blob();
    onBytes(blob.size);
    return blob;
  }
  const reader = response.body.getReader(), chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.length);
  }
  return new Blob(chunks, { type: response.headers.get('Content-Type') || '' });
}

function decodeImage(blob) {
  return new Promise((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(blob);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('An image of this map does not decode.')); };
    image.src = url;
  });
}

function showProgress(got, total) {
  $('fill').style.width = `${Math.min(100, 100 * got / total).toFixed(1)}%`;
  $('status').textContent = `LOADING  ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
}

async function load() {
  // First of all, so that a browser without WebGL 2 says so before it downloads anything.
  renderer = new Renderer($('view'), flag('nogl', false));

  // scene.json (the server gzips it) lists the sizes of its images: the bar knows
  // its total before the first of them arrives.
  const base = `data/${mapName}/`;
  const response = await fetch(base + 'scene.json');
  if (!response.ok) throw new Error(`There is no exported map "${mapName}".`);
  const sceneBytes = +response.headers.get('Content-Length') || 0;
  scene = await response.json();
  if (scene.format !== FORMAT) throw new Error(`Map "${mapName}" is from another version of the exporter: run tools/fp_export.py ${mapName}.`);
  document.title = `${scene.title} - First-person viewer for Fallout 2 (unofficial)`;
  $('place').textContent = scene.title.toUpperCase();

  const files = [scene.tiles, scene.light, ...(scene.rock ? [scene.rock] : []), ...scene.pages];
  const total = sceneBytes + files.reduce((sum, file) => sum + file.bytes, 0);
  let got = sceneBytes;
  showProgress(got, total);
  const bar = Promise.all([iface.load(), placeName()]);
  const images = await Promise.all(files.map(async (file) =>
    decodeImage(await download(base + file.image, (n) => showProgress(got += n, total)))));
  scene.place = (await bar)[1] || scene.title;
  state.downloaded = got;
  $('status').textContent = 'BUILDING';
  await new Promise(requestAnimationFrame);       // let that be seen: building blocks the page for a moment

  scene.floor = decode(scene.floor, Uint16Array);
  scene.roof = decode(scene.roof, Uint16Array);
  solid = decode(scene.solid, Uint8Array);
  proj = new Proj(scene.proj);
  north = proj.groundDir(0, -1);
  east = [north[1], -north[0]];           // north turned 90 degrees clockwise (seen from above)
  renderer.build(scene, proj, images);

  critters = scene.critters.map(([set, u, v, rot, stack, name]) => ({
    set: scene.sets[set], u, v, rot, stack, name, frame: 0, clock: 0, wait: 1 + Math.random() * 6,
  }));
  pickables = buildPickables();
  buildColliders();
  caveMood = underground(scene.ambient);

  // Start position and heading.
  let tile = scene.spawn.tile;
  if (params.has('pos')) {
    const parts = params.get('pos').split(',').map(Number);
    tile = parts.length === 2 ? parts[1] * HEX_W + parts[0] : parts[0];
  }
  [state.u, state.v] = hexGround(tile);
  state.centerTile = tile;                // iso mode centres on this tile exactly until the view moves
  const facing = proj.groundDir(...DIR_PIXELS[scene.spawn.rot % 6]);
  state.yaw = yawOf(facing);
  // The game enters a map wherever its makers put the dude, often with the nose to a wall.
  if (state.mode === 'fp' && !params.has('pos') && !params.has('yaw')) {
    [state.u, state.v, state.yaw] = clearView(state.u, state.v, state.yaw);
    state.centerTile = null;
  }
  state.yaw = number('yaw', state.yaw * 180 / Math.PI) * Math.PI / 180;
  state.pitch = number('pitch', 0) * Math.PI / 180;
}

// The place as the map menu names it ("Klamath: Downtown"; data/index.json), if it is listed there.
async function placeName() {
  try {
    const response = await fetch('data/index.json');
    const entry = response.ok && (await response.json()).find((map) => map.map === mapName);
    return entry ? entry.title : null;
  } catch (error) {
    return null;
  }
}

function hexGround(tile) {
  return proj.pxToGround(...hexPx(tile));
}

// yaw 0 looks north, positive turns clockwise; (u, v, up) is right-handed so
// clockwise seen from above is a negative rotation in the (u, v) plane.
function heading(yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [north[0] * c + east[0] * s, north[1] * c + east[1] * s];
}

function yawOf(dir) {
  return Math.atan2(dir[0] * east[0] + dir[1] * east[1], dir[0] * north[0] + dir[1] * north[1]);
}

// ---------------------------------------------------------------- collision
// The player is a circle. Walls are slabs (scene.boxes: rectangles along the
// grid axes, only the stretches whose art reaches the floor and where no door
// hangs, so doorways stay open), furniture is the box or drum it is drawn as
// (scene.blocks, scene.posts); every other blocking hex, and every hex off
// the map, is a round pillar. Overlaps are resolved by pushing the circle straight out, which is
// what makes it slide along walls and around furniture instead of sticking.
// Underground the rock (scene.rock) stops it too.
const CELL = 2;               // bucket size for slabs, boxes and drums, world units
let wallCells, postCells, rockCells;

function buildColliders() {
  const cells = (rows, reach) => {
    const map = new Map();
    for (const row of rows) {
      const [u0, v0, u1, v1] = reach(row);
      for (let i = Math.floor(u0 / CELL); i <= Math.floor(u1 / CELL); i++) {
        for (let j = Math.floor(v0 / CELL); j <= Math.floor(v1 / CELL); j++) {
          const key = i * 1000 + j;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(row);
        }
      }
    }
    return map;
  };
  wallCells = cells([...scene.blocks, ...scene.boxes], ([u0, v0, u1, v1]) => [u0 - RADIUS, v0 - RADIUS, u1 + RADIUS, v1 + RADIUS]);
  postCells = cells(scene.posts, ([u, v, r]) => [u - r - RADIUS, v - r - RADIUS, u + r + RADIUS, v + r + RADIUS]);
  // Underground: the foot of every rock face, corner to corner.
  const edges = [];
  for (const loop of scene.rock ? scene.rock.loops : []) {
    for (let i = 0; i < loop.length; i += 6) {
      const j = (i + 6) % loop.length;
      edges.push([loop[i], loop[i + 1], loop[j], loop[j + 1]]);
    }
  }
  rockCells = cells(edges, ([ua, va, ub, vb]) => [Math.min(ua, ub) - RADIUS, Math.min(va, vb) - RADIUS, Math.max(ua, ub) + RADIUS, Math.max(va, vb) + RADIUS]);
}

function isSolid(tile) {
  return tile < 0 || tile >= HEX_W * HEX_W || (solid[tile >> 3] >> (tile & 7)) & 1;
}

// Push (u, v) out of everything it overlaps.
function resolve(u, v) {
  const push = (qu, qv, reach) => {            // keep `reach` away from point q
    const du = u - qu, dv = v - qv, d = Math.hypot(du, dv);
    if (d >= reach || d < 1e-9) return;
    u = qu + du * reach / d;
    v = qv + dv * reach / d;
  };
  for (let pass = 0; pass < 4; pass++) {
    const [wasU, wasV] = [u, v];
    const tile = hexFromPx(...proj.groundToPx(u, v));
    const hx = tile < 0 ? -9 : tile % HEX_W, hy = Math.floor(tile / HEX_W);
    for (let y = hy - 2; y <= hy + 2 && tile >= 0; y++) {
      for (let x = hx - 2; x <= hx + 2; x++) {
        if (x < 0 || y < 0 || x >= HEX_W || y >= HEX_W || !isSolid(y * HEX_W + x)) continue;
        push(...hexGround(y * HEX_W + x), PILLAR + RADIUS);
      }
    }
    const cell = Math.floor(u / CELL) * 1000 + Math.floor(v / CELL);
    for (const [pu, pv, r] of postCells.get(cell) || []) push(pu, pv, r + RADIUS);
    for (const [ua, va, ub, vb] of rockCells.get(cell) || []) {      // away from the nearest point of the edge
      const du = ub - ua, dv = vb - va;
      const t = Math.max(0, Math.min(1, ((u - ua) * du + (v - va) * dv) / (du * du + dv * dv || 1)));
      push(ua + du * t, va + dv * t, RADIUS);
    }
    // Boxes, then walls, last: whatever the pillars did, the eye never ends up nearer to a wall than the radius.
    for (const [u0, v0, u1, v1] of wallCells.get(cell) || []) {
      const qu = Math.max(u0, Math.min(u1, u)), qv = Math.max(v0, Math.min(v1, v));     // nearest point of the slab
      if (qu !== u || qv !== v) { push(qu, qv, RADIUS); continue; }
      // Inside a slab (a long step): out through its nearest side.
      const [depth, du, dv] = [[u - u0, -1, 0], [u1 - u, 1, 0], [v - v0, 0, -1], [v1 - v, 0, 1]].sort((a, b) => a[0] - b[0])[0];
      u += du * (depth + RADIUS);
      v += dv * (depth + RADIUS);
    }
    if (u === wasU && v === wasV) break;          // clear of everything
  }
  return [u, v];
}

function move(du, dv) {
  state.centerTile = null;
  const steps = state.noclip ? 1 : Math.ceil(Math.hypot(du, dv) / (RADIUS * 0.5)) || 1;
  for (let i = 0; i < steps; i++) {
    const u = state.u + du / steps, v = state.v + dv / steps;
    const outside = hexFromPx(...proj.groundToPx(u, v)) < 0;         // never leave the hex grid
    if (!state.noclip && outside) return;
    [state.u, state.v] = state.noclip ? [u, v] : resolve(u, v);
  }
}

// ------------------------------------------------------------- where to start
// The nearest spot to (u, v) that one can walk to and that has a clear view, and the heading
// there with most to see: [u, v, yaw]. From each spot SIGHTS rays are walked until something
// stops them (people count). A heading is clear if its own ray goes CLEAR[0] units, the two
// beside it CLEAR[1] and the next two, at the edges of the picture, CLEAR[2]; of those the
// one wins whose five rays end on something rather than near the eye or nowhere, then the
// one nearest to the heading asked for. Spots are tried in the order of the walk to them,
// GRID apart; if none of SPOTS will do, stay.
const SIGHTS = 16, FAR = 12, CLEAR = [5, 1.8, 1.1], GRID = 0.5, SPOTS = 240;

function clearView(u, v, yaw) {
  const free = (pu, pv) => {
    if (hexFromPx(...proj.groundToPx(pu, pv)) < 0 || critters.some((c) => Math.abs(c.u - pu) + Math.abs(c.v - pv) < 0.6)) return false;
    const [ru, rv] = resolve(pu, pv);
    return Math.abs(ru - pu) + Math.abs(rv - pv) < 1e-3;
  };
  const sight = (pu, pv, angle) => {
    const h = heading(angle);
    for (let d = 0.4; d < FAR; d += 0.4) if (!free(pu + h[0] * d, pv + h[1] * d)) return d;
    return FAR;
  };
  const turn = (a) => Math.abs(Math.atan2(Math.sin(a - yaw), Math.cos(a - yaw)));
  const queue = [[0, 0]], seen = new Set(['0,0']);
  for (let n = 0; n < queue.length && n < SPOTS; n++) {
    const [i, j] = queue[n], pu = u + i * GRID, pv = v + j * GRID;
    const rays = Array.from({ length: SIGHTS }, (_, k) => sight(pu, pv, yaw + k * 2 * Math.PI / SIGHTS));
    const ray = (k) => rays[(k + SIGHTS) % SIGHTS];
    let best = null;
    for (let k = 0; k < SIGHTS; k++) {
      if (ray(k) < CLEAR[0] || Math.min(ray(k - 1), ray(k + 1)) < CLEAR[1] || Math.min(ray(k - 2), ray(k + 2)) < CLEAR[2]) continue;
      const angle = yaw + k * 2 * Math.PI / SIGHTS;
      const score = [-2, -1, 0, 1, 2].reduce((sum, d) => sum + (ray(k + d) < FAR ? Math.min(1, ray(k + d) / 4) : 0.5), 0) - 0.1 * turn(angle);
      if (!best || score > best[0]) best = [score, angle];
    }
    if (best) return [pu, pv, best[1]];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${i + di},${j + dj}`;
      if (!seen.has(key) && free(pu + di * GRID / 2, pv + dj * GRID / 2) && free(pu + di * GRID, pv + dj * GRID)) {
        seen.add(key);
        queue.push([i + di, j + dj]);
      }
    }
  }
  return [u, v, yaw];
}

// -------------------------------------------------------------------- input
const keys = new Set();
let thumbs = { axes: [0, 0] };                  // touch.js: [right, forward] of the left thumb's stick

// Ask for the mouse (pointer lock); browsers want a click for that and may still refuse.
function grabMouse() {
  const canvas = renderer.canvas;
  if (state.mode !== 'fp' || !canvas.requestPointerLock || document.body.classList.contains('touch')) return;
  try {
    Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  } catch (error) { /* then the keys still walk and turn */ }
}

function toggleFullscreen() {
  const root = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const entering = (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' });
    Promise.resolve(entering).then(() => screen.orientation.lock('landscape')).catch(() => {});   // where it is allowed
  }
}

function setupInput(canvas) {
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) return;
    if (!state.entered) {
      if (ready && !dead && (e.code === 'Enter' || e.code === 'Space')) enter();
      return;
    }
    keys.add(e.code);
    const toggles = { KeyF: 'debug', KeyN: 'noclip', KeyR: 'roofs', Tab: 'plan', KeyO: 'solids' };
    const settings = { KeyP: 'retro', KeyV: 'fov', KeyB: 'bob', KeyH: 'hud' };
    if (toggles[e.code] && !e.repeat) state[toggles[e.code]] = !state[toggles[e.code]];
    if (settings[e.code] && !e.repeat) advance(settings[e.code]);
    if (e.code === 'KeyM') state.mode = { fp: 'iso', iso: 'top', top: 'fp' }[state.mode];
    if (e.code === 'KeyT') nextTime();
    if ((e.code === 'KeyE' || e.code === 'Enter') && !e.repeat) examine();
    if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  canvas.addEventListener('click', grabMouse);
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) look(e.movementX * MOUSE_LOOK * state.turn, -e.movementY * MOUSE_LOOK * state.turn);
  });
  canvas.addEventListener('wheel', (e) => {
    if (state.mode !== 'fp') state.zoom = Math.min(8, Math.max(0.25, state.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
    e.preventDefault();
  }, { passive: false });

  thumbs = touchControls(canvas, $('stick'), $('knob'),
    (dx, dy) => (state.mode === 'fp' ? look(dx * TOUCH_LOOK[0] * state.turn, -dy * TOUCH_LOOK[1] * state.turn) : pan(-dx, -dy)),
    (x, y) => { const id = pickAt(x, y); if (id >= 0) examine(id); });     // a tap on nothing says nothing
  const actions = {
    // The whole start screen is its key: enter, or start over after fail(..., true).
    overlay: () => ready && (dead ? location.reload() : (enter(), grabMouse())),
    look: () => examine(), time: nextTime, full: toggleFullscreen,
    plans: () => { state.plan = !state.plan; }, run: () => { state.run = !state.run; },
    pixels: () => advance('retro'), set: () => { state.options = !state.options; },
  };
  for (const [id, action] of Object.entries(actions)) press($(id), () => { action(); hud(); });
  // The settings: one key each, which says what is set and moves on to the next choice.
  for (const name of Object.keys(SETTINGS).filter((name) => name !== 'retro')) {
    const key = $('options').appendChild(document.createElement('button'));
    key.className = 'key';
    key.dataset.setting = name;
    press(key, () => { advance(name); hud(); });
  }
  const root = document.documentElement;
  $('full').hidden = !(root.requestFullscreen || root.webkitRequestFullscreen);      // an iPhone has neither

  // No pinch zoom (iOS), no long-press menu, no double-tap zoom anywhere on the page.
  for (const type of ['gesturestart', 'contextmenu', 'dblclick']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
}

function look(dyaw, dpitch) {
  state.yaw += dyaw;
  state.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, state.pitch + dpitch));
}

// Slide the iso / top view by screen pixels.
function pan(dx, dy) {
  if (state.mode === 'iso') {
    const [du, dv] = proj.deltaToGround(dx / state.zoom, dy / state.zoom);
    state.u += du; state.v += dv;
  } else {
    const k = 1 / (TOP_SCALE * state.zoom);
    state.u += (east[0] * dx - north[0] * dy) * k;
    state.v += (east[1] * dx - north[1] * dy) * k;
  }
  state.centerTile = null;
}

function update(dt) {
  let forward = 0, strafe = 0, turn = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) forward += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) forward -= 1;
  if (keys.has('KeyD')) strafe += 1;
  if (keys.has('KeyA')) strafe -= 1;
  if (keys.has('ArrowRight')) turn += 1;
  if (keys.has('ArrowLeft')) turn -= 1;
  strafe += thumbs.axes[0];                          // analogue: a thumb pushed half way walks at half speed
  forward += thumbs.axes[1];
  const run = state.run || keys.has('ShiftLeft') || keys.has('ShiftRight');
  if (state.mode !== 'fp') {
    const speed = (run ? 1200 : 500) * dt;
    if (forward || strafe || turn) pan((strafe + turn) * speed, -forward * speed);
    return;
  }
  state.yaw += turn * 2.2 * state.turn * dt;
  // The speed follows the keys with a short lag instead of jumping, and the
  // head-bob follows the distance really covered (none while pushing a wall).
  const length = Math.hypot(forward, strafe);
  const speed = length > 0 ? (run ? RUN : WALK) * state.speed * Math.min(1, length) / length : 0;
  const f = heading(state.yaw), r = heading(state.yaw + Math.PI / 2), follow = 1 - Math.exp(-ACCEL * dt);
  const v = state.velocity;
  v[0] += ((f[0] * forward + r[0] * strafe) * speed - v[0]) * follow;
  v[1] += ((f[1] * forward + r[1] * strafe) * speed - v[1]) * follow;
  let walked = 0;
  if (Math.hypot(v[0], v[1]) > 0.01) {
    const from = [state.u, state.v];
    move(v[0] * dt, v[1] * dt);
    walked = Math.hypot(state.u - from[0], state.v - from[1]);
  }
  state.stride += walked / STRIDE * 2 * Math.PI;
  state.sway += (Math.min(1, walked / (dt || 1) / (WALK * state.speed)) - state.sway) * follow;
}

// The light under the open sky: time of day, or what the map script fixes underground.
function nextTime() {
  if (scene.indoor) return say('No daylight down here.');
  state.time = TIMES[(TIMES.indexOf(state.time) + 1) % TIMES.length];
  say(`Time of day: ${state.time}.`);
}

function currentMood() {
  if (scene.indoor) return caveMood;
  const mood = state.blend === null ? MOODS[state.time] : blendedMood(state.blend);
  if (scene.ambient >= 1) return mood;
  // Under the sky, but the map script dims the light (cave mouths, a few encounters).
  if (dimmed.from !== mood) dimmed = { from: mood, mood: { ...mood, sky: mood.sky.map((c) => c * scene.ambient) } };
  return dimmed.mood;
}
let dimmed = {};

// Filming: the light between two times of day. x: 0 = day, 1 = dusk, 2 = night; a whole
// number gives that mood itself. Colours and fog are mixed; from day to dusk the sun sinks
// along the way, from dusk to night it goes under in the first half and the moon comes up
// in the second (`disc`: where the sky paints it, and how bright).
function blendedMood(x) {
  x = Math.max(0, Math.min(TIMES.length - 1, x));
  const i = Math.min(TIMES.length - 2, Math.floor(x)), f = x - i;
  const a = MOODS[TIMES[i]], b = MOODS[TIMES[i + 1]];
  if (f === 0) return a;
  const mix = (p, q) => (Array.isArray(p) ? p.map((c, k) => c + (q[k] - c) * f) : p + (q - p) * f);
  const mood = {};
  for (const key of Object.keys(a)) mood[key] = mix(a[key], b[key]);
  mood.colour = mix(a.colour ?? 1, b.colour ?? 1);
  const turn = ((b.sun[0] - a.sun[0] + 540) % 360) - 180;              // the short way round
  mood.sun = [a.sun[0] + turn * f, mix(a.sun[1], b.sun[1])];
  if (TIMES[i + 1] === 'night') {
    mood.disc = f < 0.5 ? [a.sun[0] + 24 * f, a.sun[1] - 22 * f] : b.sun;
    mood.sunColour = (f < 0.5 ? a : b).sunColour.map((c) => c * Math.abs(1 - 2 * f));
  }
  return mood;
}

const lightName = (x) => LIGHTS[TIMES[Math.round(Math.max(0, Math.min(TIMES.length - 1, x)))]];

// ------------------------------------------------------------------ cameras
const TOP_SCALE = 24;         // top view: pixels per world unit at zoom 1

// Column-major 4x4 from four rows.
function rows(r0, r1, r2, r3) {
  return new Float32Array([r0[0], r1[0], r2[0], r3[0], r0[1], r1[1], r2[1], r3[1],
                           r0[2], r1[2], r2[2], r3[2], r0[3], r1[3], r2[3], r3[3]]);
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function fpView(width, height) {
  const aspect = width / height, tan = (degrees) => Math.tan(degrees * Math.PI / 360);
  let tanX = Math.min(tan(state.fov) * aspect, tan(MAX_HFOV));
  const tanY = Math.min(Math.max(tanX, tan(MIN_HFOV)) / aspect, tan(Math.max(state.fov, MAX_VFOV)));
  tanX = tanY * aspect;
  const h = heading(state.yaw), cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
  const f = [h[0] * cp, h[1] * cp, sp];
  const hr = heading(state.yaw + Math.PI / 2);
  const r = [hr[0], hr[1], 0];
  const up = [-h[0] * sp, -h[1] * sp, cp];
  // Head-bob: the eye sways sideways once per two steps and dips at every step.
  const bob = state.bob ? state.sway : 0, side = Math.sin(state.stride) * BOB[0] * bob;
  const eye = [state.u + r[0] * side, state.v + r[1] * side, state.eye - Math.abs(Math.sin(state.stride)) * BOB[1] * bob];
  const near = 0.05, far = 600, a = (far + near) / (near - far), b = 2 * far * near / (near - far);
  const fe = dot(f, eye);
  // The interface bar covers the lowest `lift` of the page. The picture keeps its size and
  // its field of view and slides up by half the bar's height, so that the horizon and the
  // crosshair stand in the middle of what stays visible; what slides off the top is lost,
  // what is behind the bar was floor at one's feet. (A sheared frustum: no line bends.)
  const lift = state.lift;
  return {
    mode: 'fp', eye, right: r, up: [0, 0, 1], toward: [-h[0], -h[1], 0], tan: [tanX, tanY], forward: f, cameraUp: up, lift,
    skyForward: f.map((c, i) => c - up[i] * tanY * lift),        // the ray through the middle of the page
    // Cards take their depth from a plane across the grid axis we mostly look along (render.js).
    cardNormal: Math.abs(h[1]) >= Math.abs(h[0]) ? [0, 1, 0] : [1, 0, 0], ray: [0, 0, 0, 0],
    matrix: rows([r[0] / tanX, r[1] / tanX, r[2] / tanX, -dot(r, eye) / tanX],
                 [up[0] / tanY + lift * f[0], up[1] / tanY + lift * f[1], up[2] / tanY + lift * f[2], -dot(up, eye) / tanY - lift * fe],
                 [-a * f[0], -a * f[1], -a * f[2], a * fe + b],
                 [f[0], f[1], f[2], -fe]),
  };
}

// The game's camera: px = origin + u squ + v sqv - (0, hpx z), with the view
// centre placed where the engine puts the centre hex of a width x height window.
const DEPTH = 64;             // iso depth range, units either side of the view centre (the screen shows +-20)

function isoView(width, height) {
  const p = proj, z = state.zoom;
  // Whole pixels keep the texel grid aligned with the screen after panning.
  const [cx, cy] = state.centerTile != null ? hexPx(state.centerTile) : p.groundToPx(state.u, state.v).map(Math.round);
  const sx = Math.floor((width - 32) / 2) + 16, sy = Math.floor((height - 16) / 2) + 8;
  const kx = 2 * z / width, ky = 2 * z / height;
  const toCamera = p.towardCamera();
  const centre = [state.u, state.v, 0];
  const right = p.groundDir(1, 0), toward = p.groundDir(0, 1);
  return {
    mode: 'iso', eye: centre, right: [right[0], right[1], 0], up: [0, 0, 1], toward: [toward[0], toward[1], 0],
    cardNormal: [0, 1, 0], ray: [...toCamera, 1],
    matrix: rows([p.squ[0] * kx, p.sqv[0] * kx, 0, (p.origin[0] - cx) * kx + 2 * sx / width - 1],
                 [-p.squ[1] * ky, -p.sqv[1] * ky, p.hpx * ky, -(p.origin[1] - cy) * ky + 1 - 2 * sy / height],
                 [-toCamera[0] / DEPTH, -toCamera[1] / DEPTH, -toCamera[2] / DEPTH, dot(toCamera, centre) / DEPTH],
                 [0, 0, 0, 1]),
  };
}

function topView(width, height) {
  const s = TOP_SCALE * state.zoom, kx = 2 * s / width, ky = 2 * s / height;
  const c = [state.u, state.v];
  const e = [east[0], east[1], 0], n = [north[0], north[1], 0];
  return {
    mode: 'top', eye: [c[0], c[1], 0], right: e, up: n, toward: [0, 0, 0], cardNormal: [0, 1, 0], ray: [0, 0, -1, 1],
    matrix: rows([e[0] * kx, e[1] * kx, 0, -(e[0] * c[0] + e[1] * c[1]) * kx],
                 [n[0] * ky, n[1] * ky, 0, -(n[0] * c[0] + n[1] * c[1]) * ky],
                 [0, 0, -0.1, 0],
                 [0, 0, 0, 1]),
  };
}

// -------------------------------------------------------------------- doors
// Nothing can use a door yet, so a door simply opens (disappears) while the
// player stands within reach of it, and shuts again behind them.
const DOOR_REACH = 1.2;
let openDoors = new Set();

function updateDoors() {
  const open = new Set();
  if (state.mode === 'fp') {
    for (const door of scene.doors) {
      const [, ua, va, ub, vb] = door;
      if (Math.hypot((ua + ub) / 2 - state.u, (va + vb) / 2 - state.v) < DOOR_REACH) open.add(door);
    }
  }
  if (open.size === openDoors.size && [...open].every((door) => openDoors.has(door))) return;
  openDoors = open;
  renderer.setDoors(scene.doors.filter((door) => !open.has(door)));
}

// ----------------------------------------------------------------- critters
// Six facings were rendered for the game's camera. Seen from another side the
// critter shows the facing that makes the same angle with the viewer as its
// real facing makes with us (Doom's sprite rotations).
let facingAngles, cameraAngle;

// Filming: which frame of its fidget critter n shows at `time` seconds. The same waits as
// below, but drawn from the critter's number, the round and `state.seed` instead of the dice,
// so that a picture depends on nothing but its time.
function fidgetFrame(c, n, time) {
  const frames = c.set.dirs[0].length, length = frames / c.set.fps;
  if (frames < 2 || !(c.set.fps > 0)) return 0;
  for (let round = 0, from = 0; from <= time; round++) {
    let x = (Math.imul(n + 1, 0x9E3779B1) ^ Math.imul(round + 1, 0x85EBCA6B) ^ Math.imul(state.seed + 1, 0xC2B2AE35)) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x2C1B3C6D); x = Math.imul(x ^ (x >>> 12), 0x297A2D39); x = (x ^ (x >>> 15)) >>> 0;
    from += round ? 2 + x / 2 ** 32 * 7 : 1 + x / 2 ** 32 * 6;
    if (time >= from && time < from + length) return Math.min(frames - 1, Math.floor((time - from) * c.set.fps));
    from += length;
  }
  return 0;
}

// dt: seconds since the last picture; at: filming, the time of this picture instead.
function critterSprites(dt, view, at = null) {
  if (!facingAngles) {
    facingAngles = DIR_PIXELS.map((d) => Math.atan2(...proj.groundDir(...d).reverse()));
    cameraAngle = Math.atan2(...proj.groundDir(0, 1).reverse());       // ground direction towards the game's camera
  }
  return critters.map((c, n) => {
    const frames = c.set.dirs[0].length;
    if (at !== null) {
      c.frame = state.anim ? fidgetFrame(c, n, at) : 0;
    } else if (state.anim && frames > 1) {            // stand still, fidget now and then
      c.clock += dt;
      if (c.wait > 0) {
        if (c.clock >= c.wait) { c.wait = 0; c.clock = 0; }
      } else {
        c.frame = Math.floor(c.clock * c.set.fps);
        if (c.frame >= frames) { c.frame = 0; c.clock = 0; c.wait = 2 + Math.random() * 7; }
      }
    }
    let rot = c.rot;
    if (view.mode === 'fp') {
      const toViewer = Math.atan2(state.v - c.v, state.u - c.u);
      const wanted = facingAngles[c.rot] - toViewer + cameraAngle;
      let best = Infinity;
      facingAngles.forEach((angle, r) => {
        const d = Math.abs(Math.atan2(Math.sin(angle - wanted), Math.cos(angle - wanted)));
        if (d < best) { best = d; rot = r; }
      });
    }
    return { index: c.set.dirs[rot][c.frame], sprite: scene.sprites[c.set.dirs[rot][c.frame]], u: c.u, v: c.v, stack: c.stack };
  });
}

// ------------------------------------------------------------- looking at
function buildPickables() {
  const list = [];
  for (const [, ua, va, ub, vb, z0, z1, name] of scene.walls) list.push({ wall: [ua, va, ub, vb, z0, z1], name });
  for (const door of scene.doors) list.push({ wall: door.slice(1, 7), name: door[7], door });
  const unshadowed = new Map(scene.shadows.map(([board, body]) => [board, body]));      // as first person draws them
  const solid = new Set(scene.hidden), lifted = new Map(scene.lifts.map(([board, ...to]) => [board, to]));
  scene.boards.forEach(([s, u, v, , name], n) => {
    const [du, dv, z] = lifted.get(n) || [0, 0, 0];
    if (!solid.has(n)) list.push({ sprite: scene.sprites[unshadowed.get(n) ?? s], u: u + du, v: v + dv, z, name });
  });
  // Solids: the box around each (a drum's ellipse is a x b px on the game's screen; a table
  // top on a stem has no thickness of its own).
  for (const [, , , , round, cu, cv, a, b, z0, z1, , , name] of scene.props) {
    const [du, dv] = round ? [a / proj.bbPx, a / proj.bbPx] : [a / 2, b / 2];
    list.push({ box: [[cu - du, cv - dv, Math.min(z0, z1 - 0.06)], [cu + du, cv + dv, z1]], name });
  }
  return list;
}

// Index into scene.names of the nearest wall or sprite card that the ray from the eye
// along the unit vector f passes through (default: the middle of the view), or -1.
function pick(view, critterList, f = view.forward) {
  const e = view.eye, r = view.right, toward = view.toward;
  let best = LOOK_RANGE, name = -1;
  const board = (sprite, u, v, id, z = 0) => {
    // The card stands upright on the middle of its footprint, across the way we look.
    const c = card(proj, sprite);
    const [du, dv] = proj.deltaToGround(0, c.shift);
    const t = ((u + du - e[0]) * toward[0] + (v + dv - e[1]) * toward[1]) / (f[0] * toward[0] + f[1] * toward[1]);
    if (!(t > 0.05 && t < best)) return;
    const up = e[2] + f[2] * t - z;
    const x = ((e[0] + f[0] * t - u - du) * r[0] + (e[1] + f[1] * t - v - dv) * r[1]) * proj.bbPx - sprite[5];
    if (up >= c.up0 && up <= c.up1 && x >= 0 && x <= sprite[3]) { best = t; name = id; }
  };
  for (const p of pickables) {
    if (p.sprite) { board(p.sprite, p.u, p.v, p.name, p.z); continue; }
    if (p.box) {                                    // where the ray enters the box, if it does
      let from = 0.05, to = best;
      for (let k = 0; k < 3; k++) {
        const a = (p.box[0][k] - e[k]) / f[k], b = (p.box[1][k] - e[k]) / f[k];
        from = Math.max(from, Math.min(a, b));
        to = Math.min(to, Math.max(a, b));
      }
      if (from < to) { best = from; name = p.name; }
      continue;
    }
    if (p.door && openDoors.has(p.door)) continue;
    const [ua, va, ub, vb, z0, z1] = p.wall;
    const du = ub - ua, dv = vb - va;
    const denom = f[0] * -dv + f[1] * du;
    if (Math.abs(denom) < 1e-6) continue;
    const t = ((ua - e[0]) * -dv + (va - e[1]) * du) / denom;
    if (!(t > 0.05 && t < best)) continue;
    const along = ((e[0] + f[0] * t - ua) * du + (e[1] + f[1] * t - va) * dv) / (du * du + dv * dv);
    const z = e[2] + f[2] * t;
    if (along >= 0 && along <= 1 && z >= z0 && z <= z1) { best = t; name = p.name; }
  }
  critterList.forEach((c, i) => board(c.sprite, c.u, c.v, critters[i].name));
  return name;
}

// ------------------------------------------------------------ message line
// What the game prints into its message window when you look at something:
// the name, then the proto's description.
const MESSAGE_SECONDS = 8, MESSAGE_LINES = 4;
const messages = [];          // {text, until}

function say(text) {
  messages.push({ text, until: performance.now() + MESSAGE_SECONDS * 1000 });
  messages.splice(0, messages.length - MESSAGE_LINES);
  iface.say(text);              // the bar's monitor keeps its lines, as the game's does
  showMessages();
}

function showMessages() {
  const now = performance.now();
  while (messages.length && messages[0].until < now) messages.shift();
  const log = $('log');
  log.hidden = !messages.length || barShown();
  log.textContent = messages.map((m) => '\u2022 ' + m.text).join('\n');
}

// --------------------------------------------------------- interface bar
// The game's own bar under the picture (hud.js): first person only, not with ui=0, and
// not where the page is too narrow for its 640 pixels at a size one can read (a phone held
// upright: there the messages stay on the old line). Decided by layoutBar.
function barShown() {
  return barPixel > 0;
}

// Size and place of the bar on the page as it is now, and how far the picture makes way
// for it (state.lift, fpView). fp.css moves the crosshair, the hints and the keys by --bar.
const BESIDE = 78;            // CSS pixels free beside the bar from which the thumb keys stand there
const BAR_SMALLEST = 0.75;    // CSS pixels to each pixel of the bar below which it is not shown
const BAR_FINER = 1.5;        // see barBlock
let barKey = '', barPixel = 0;                // barPixel: screen pixels to each pixel of the bar, 0 without it

function layoutBar() {
  const canvas = renderer.canvas, wanted = iface.ready && state.hud && state.ui && state.mode === 'fp';
  const key = [wanted, canvas.clientWidth, canvas.clientHeight, devicePixelRatio].join();
  if (key === barKey) return;
  barKey = key;
  const dpr = devicePixelRatio || 1;
  let place = wanted ? iface.place(canvas.clientWidth, canvas.clientHeight, dpr) : null;
  if (place && place.scale / dpr < BAR_SMALLEST) place = null;
  const shown = !!place;
  if (!place) place = { height: 0, side: 0 };
  state.lift = shown ? Math.min(0.5, place.height / canvas.clientHeight) : 0;
  barPixel = shown ? place.scale : 0;
  document.body.classList.toggle('iface', shown);
  document.body.classList.toggle('beside', shown && place.side >= BESIDE);
  document.body.style.setProperty('--bar', `${place.height}px`);
  document.body.style.setProperty('--side', `${place.side}px`);
}

// Retro with the bar: the picture takes the size of the bar's pixels, so that one grid of
// squares goes through bar and picture (at 1280 x 720 a screen of 640 x 360, as the game's is
// 640 x 480). Not where that would make the picture more than BAR_FINER times the rows the
// retro look is made for (a screen much taller than the bar is wide): then by the rule of
// render.js. scale: canvas pixels per CSS pixel. Returns canvas pixels per picture pixel, 0 = by the rule.
function barBlock(scale) {
  const block = barPixel * scale / (devicePixelRatio || 1);
  const whole = Math.round(block);
  if (whole < 1 || Math.abs(block - whole) > 1e-6) return 0;
  return renderer.canvas.clientHeight * scale / whole <= RETRO_LINES * BAR_FINER ? whole : 0;
}

const LIGHTS = { day: 'Day', dusk: 'Dusk', night: 'Night' };

function drawBar() {
  if (!barShown()) return;
  iface.label(scene.place, scene.indoor ? 'Underground' : state.blend === null ? LIGHTS[state.time] : lightName(state.blend));
  iface.draw();
}

// What is drawn at a point of the page (CSS pixels): where a finger tapped.
function pickAt(x, y) {
  const [view, critterList] = shown;
  if (view.mode !== 'fp') return -1;
  const { clientWidth, clientHeight } = renderer.canvas;      // the canvas fills the page
  const nx = (2 * x / clientWidth - 1) * view.tan[0], ny = (1 - 2 * y / clientHeight - view.lift) * view.tan[1];
  const f = view.forward.map((c, i) => c + view.right[i] * nx + view.cameraUp[i] * ny);
  const length = Math.hypot(...f);
  return pick(view, critterList, f.map((c) => c / length));
}

// Text comes from the user's exported game data, with neutral defaults for old scenes.
function describe(id) {
  if (id < 0) return scene.messages?.nothing || 'No details to inspect here.';
  const label = (scene.messages?.see || 'Object: %s.').replace('%s', () => scene.names[id]);
  return label + (scene.descriptions[id] ? ' ' + scene.descriptions[id] : '');
}

// id: index into scene.names (default: what the crosshair is on)
function examine(id = state.lookingAt) {
  if (state.mode !== 'fp' || !scene) return;
  say(describe(id));
}

// ------------------------------------------------------------------ minimap
// The map from above in the game's orientation (north = up the game's screen):
// floor, roofed floor, walls, doors, critters, drawn once; every frame only the
// window around the player and the arrow.
const PLAN_SCALE = 5;         // pixels per world unit
const PLAN_SIZE = 168;        // CSS pixels of the square window
let plan;                     // {canvas, x0, y0}

const planPoint = (u, v) => [u * east[0] + v * east[1], -(u * north[0] + v * north[1])];

function buildPlan() {
  const corners = [[0, 0], [100, 0], [100, 100], [0, 100]].map(([u, v]) => planPoint(u, v));
  const x0 = Math.min(...corners.map((c) => c[0])), y0 = Math.min(...corners.map((c) => c[1]));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((Math.max(...corners.map((c) => c[0])) - x0) * PLAN_SCALE);
  canvas.height = Math.ceil((Math.max(...corners.map((c) => c[1])) - y0) * PLAN_SCALE);
  const g = canvas.getContext('2d');
  const at = (u, v) => { const [x, y] = planPoint(u, v); return [(x - x0) * PLAN_SCALE, (y - y0) * PLAN_SCALE]; };
  const path = (points) => { g.beginPath(); points.forEach((p, i) => (i ? g.lineTo(...at(...p)) : g.moveTo(...at(...p)))); };
  for (const [ids, colour] of [[scene.floor, 'rgba(60, 240, 122, 0.13)'], [scene.roof, 'rgba(60, 240, 122, 0.16)']]) {
    g.fillStyle = colour;
    for (let sq = 0; sq < 10000; sq++) {
      if (!ids[sq] || (scene.indoor && ids[sq] - 1 === scene.ground.cell)) continue;      // underground: not the rock
      const u = sq % 100, v = Math.floor(sq / 100);
      path([[u, v], [u + 1, v], [u + 1, v + 1], [u, v + 1]]);
      g.fill();
    }
  }
  for (const [quads, colour, width] of [[scene.walls, '#3cf07a', 1.2], [scene.doors, '#f0b83c', 2]]) {
    g.strokeStyle = colour;
    g.lineWidth = width;
    for (const [, ua, va, ub, vb] of quads) { path([[ua, va], [ub, vb]]); g.stroke(); }
  }
  g.fillStyle = '#d8ffe4';
  for (const [, u, v] of scene.critters) { const [x, y] = at(u, v); g.fillRect(x - 1, y - 1, 2.5, 2.5); }
  plan = { canvas, x0, y0 };
}

let planKey = '';

function drawPlan() {
  const canvas = $('plan'), show = state.plan && state.mode === 'fp';
  canvas.hidden = !show;
  const key = [state.u.toFixed(2), state.v.toFixed(2), state.yaw.toFixed(2)].join();
  if (!show || key === planKey) return;
  planKey = key;
  if (!plan) buildPlan();
  const dpr = Math.min(devicePixelRatio || 1, 2), size = PLAN_SIZE * dpr;
  if (canvas.width !== size) canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, PLAN_SIZE, PLAN_SIZE);
  const [x, y] = planPoint(state.u, state.v), half = PLAN_SIZE / 2;
  g.drawImage(plan.canvas, half - (x - plan.x0) * PLAN_SCALE, half - (y - plan.y0) * PLAN_SCALE);
  g.translate(half, half);
  g.rotate(state.yaw);
  g.fillStyle = '#f0f8c0';
  g.beginPath();
  g.moveTo(0, -7); g.lineTo(4.5, 5); g.lineTo(0, 2.5); g.lineTo(-4.5, 5);
  g.fill();
}

// --------------------------------------------------------------------- loop
let last = 0, frames = 0, fpsClock = 0, ready = false, dead = false, lookClock = 0, clock = 0;
let shown = [];               // [view, critters] of the picture on screen
let stepDown = 0, slow = 0;   // see MAX_SCALE

function renderScale() {
  const native = Math.min(devicePixelRatio || 1, MAX_SCALE);
  if (number('scale', 0)) return number('scale', 0);
  if (state.mode === 'fp' && state.retro) return Math.min(devicePixelRatio || 1, RETRO_SCALE);
  return state.mode === 'fp' ? Math.max(1, native - stepDown) : native;
}

// One picture: advance critters and doors by dt seconds, draw. Returns the view and the critters shown.
// at: filming, the time of this picture in seconds; everything that moves by itself follows it.
function render(dt, at = null) {
  const canvas = renderer.canvas, scale = renderScale();
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
  }
  clock = at === null ? clock + dt : at;
  layoutBar();
  const view = { fp: fpView, iso: isoView, top: topView }[state.mode](width, height);
  const mood = currentMood(), radians = (degrees) => degrees * Math.PI / 180;
  const sun = mood.sun.map(radians), disc = (mood.disc || mood.sun).map(radians), discAt = heading(disc[0]);
  view.roofs = state.roofs;
  view.solids = state.solids;
  view.retro = state.retro;
  view.block = state.block || (state.retro ? barBlock(scale) : 0);
  view.proxies = state.proxies;
  view.mood = mood;
  view.sunAt = heading(sun[0]);
  view.sunDir = [discAt[0] * Math.cos(disc[1]), discAt[1] * Math.cos(disc[1]), Math.sin(disc[1])];
  view.flicker = state.anim ? 0.88 + 0.07 * Math.sin(clock * 11) + 0.05 * Math.sin(clock * 23.7) : 1;   // of flames
  updateDoors();
  const critterList = critterSprites(dt, view, at);
  renderer.setCritters(critterList, critterList.reduce((key, c) => (key * 31 + c.index) | 0, 7));
  renderer.draw(view);
  return [view, critterList];
}

function frame(now) {
  if (dead) return;
  requestAnimationFrame(frame);
  const elapsed = (now - last) / 1000 || 0, dt = Math.min(0.1, elapsed);
  last = now;
  if (state.entered) update(dt);
  shown = render(dt);
  drawPlan();
  drawBar();

  // Slow frames: count them against the fast ones, and give the GPU fewer pixels when they win.
  if (ready && state.mode === 'fp' && !state.retro && !document.hidden) {
    slow = Math.max(0, slow + (elapsed * 1000 > SLOW_MS ? 1 : -1));
    if (slow >= SLOW_FRAMES && renderScale() > 1) { stepDown += SCALE_STEP; slow = 0; }
  }
  frames++; fpsClock += dt; lookClock += dt;
  if (fpsClock >= 0.5) { state.fps = Math.round(frames / fpsClock); frames = 0; fpsClock = 0; }
  if (lookClock >= 0.1) {
    lookClock = 0;
    state.lookingAt = shown[0].mode === 'fp' ? pick(...shown) : -1;
    hud();
  }
  if (!ready) {
    ready = true;
    console.log('[fp] ready');
    // The place is there, dimmed behind the start screen: one tap and the player is in it.
    $('meter').hidden = true;
    $('status').textContent = '';
    $('enter').hidden = false;
    const scripted = state.mode !== 'fp' || !flag('start', true);
    document.body.classList.toggle('instant', scripted);
    document.body.classList.add('shown');
    if (scripted) enter();
  }
}

function hud() {
  const fp = state.mode === 'fp';
  document.body.classList.toggle('noui', !state.ui);
  document.body.classList.toggle('pixels', !fp);          // the game's views are shown pixel for pixel
  layoutBar();
  for (const id of ['cross', 'pad', 'plans', 'time', 'pixels', 'set']) $(id).hidden = !fp;
  $('run').classList.toggle('on', state.run);
  $('plans').classList.toggle('on', state.plan);
  $('pixels').textContent = settingName('retro');
  $('set').classList.toggle('on', state.options);
  $('options').hidden = !(fp && state.options);
  for (const key of $('options').children) key.textContent = `${SETTINGS[key.dataset.setting][0]}: ${settingName(key.dataset.setting)}`;
  $('label').textContent = state.lookingAt < 0 ? '' : scene.names[state.lookingAt];
  showMessages();
  const debug = $('debug');
  debug.hidden = !state.debug;
  if (state.debug) {
    const tile = hexFromPx(...proj.groundToPx(state.u, state.v));
    const deg = (a) => (((a * 180 / Math.PI) % 360 + 360) % 360).toFixed(0);
    debug.textContent = `${state.fps} fps  ${Math.round(renderer.drawn)} quads  ${renderer.calls} draw calls  ${scene.map} [${state.mode}]\n`
      + `hex ${tile % HEX_W},${Math.floor(tile / HEX_W)} (tile ${tile})  u ${state.u.toFixed(2)} v ${state.v.toFixed(2)}\n`
      + `yaw ${deg(state.yaw)}  pitch ${(state.pitch * 180 / Math.PI).toFixed(0)}`
      + `${state.noclip ? '  noclip' : ''}${state.roofs ? '' : '  roofs off'}\n`
      + `canvas ${renderer.canvas.width}x${renderer.canvas.height} (x${renderScale()})  picture ${fp ? `${renderer.buffers.width}x${renderer.buffers.height}` : 'as the canvas'}\n`
      + `textures ${(renderer.textureBytes / 1e6).toFixed(0)} MB  download ${(state.downloaded / 1e6).toFixed(2)} MB`;
  }
}

// ------------------------------------------------------------- start screen
// It shows the download, then waits for one tap or click: the gesture a browser
// wants before it hands over the mouse. Until then the map is drawn but nothing moves.
function enter() {
  state.entered = true;
  if (!iface.lines.length) iface.say(`${scene.place}.`);     // the bar's monitor is not left blank
  document.body.classList.add('entered');       // fp.css: the crosshair and the keys appear
  $('overlay').classList.add('gone');           // ... and the start screen fades out, then is hidden
  setTimeout(() => { $('overlay').hidden = !dead; }, document.body.classList.contains('instant') ? 0 : 400);
}

// Something went wrong for good: say so on the start screen. reload: a tap on it starts over.
function fail(message, reload = false) {
  dead = true;
  console.error('[fp] ' + message);
  document.body.classList.remove('noui');
  $('overlay').hidden = false;
  $('overlay').classList.remove('gone');
  $('overlay').classList.add('error');
  $('meter').hidden = true;
  $('status').textContent = message;
  $('enter').hidden = !reload;
  $('enter').textContent = 'RELOAD';
}

document.body.classList.add(mapName ? 'walk' : 'menu');
document.body.classList.toggle('touch', matchMedia('(pointer: coarse)').matches);
addEventListener('touchstart', () => document.body.classList.add('touch'), { once: true, passive: true });

if (!mapName) {
  showMenu($('maps'), $('prompt'));
} else {
  document.body.classList.toggle('noui', !state.ui);
  load().then(() => {
    setupInput(renderer.canvas);
    // A phone may take the GPU away from a page in the background.
    renderer.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      fail('The browser took the graphics away from this page.', true);
    });
    // For scripted checks: fp.state, fp.goto(hx, hy, yawDeg, pitchDeg), fp.lookAt(hx, hy, height),
    // fp.walk(du, dv), fp.examine(), fp.bench(frames), fp.scale(), fp.pose() (where one stands,
    // as a key of a camera path: capture.js), fp.iface (the bar).
    window.fp = {
      state, scene, proj, critters, examine, scale: renderScale, iface,
      pose() {
        const tile = hexFromPx(...proj.groundToPx(state.u, state.v)), round = (x, digits) => +x.toFixed(digits);
        return { at: [round(state.u, 3), round(state.v, 3)], hex: [tile % HEX_W, Math.floor(tile / HEX_W)],
                 yaw: round(((state.yaw * 180 / Math.PI) % 360 + 360) % 360, 1), pitch: round(state.pitch * 180 / Math.PI, 1) };
      },
      goto(hx, hy, yaw, pitch = 0) {
        [state.u, state.v] = hexGround(hy * HEX_W + hx);
        state.centerTile = hy * HEX_W + hx;
        if (yaw != null) state.yaw = yaw * Math.PI / 180;
        state.pitch = pitch * Math.PI / 180;
      },
      lookAt(hx, hy, height = 0.8) {
        const [u, v] = hexGround(hy * HEX_W + hx);
        state.yaw = yawOf([u - state.u, v - state.v]);
        state.pitch = Math.atan2(height - state.eye, Math.hypot(u - state.u, v - state.v));
      },
      // Walk the ground vector (du, dv) with collisions, facing that way; returns where the player ends up.
      walk(du, dv) {
        state.yaw = yawOf([du, dv]);
        state.pitch = 0;
        move(du, dv);
        return [state.u, state.v];
      },
      // Milliseconds per picture, drawn back to back and finished by the GPU (readPixels waits for it).
      bench(count = 200) {
        const gl = renderer.gl, pixel = new Uint8Array(4);
        const run = () => {
          const start = performance.now();
          for (let i = 0; i < count; i++) render(0);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return (performance.now() - start) / count;
        };
        run();                                          // warm up
        return { ms: +run().toFixed(2), calls: renderer.calls, quads: Math.round(renderer.drawn),
                 size: [renderer.canvas.width, renderer.canvas.height],
                 picture: state.mode === 'fp' ? [renderer.buffers.width, renderer.buffers.height] : null };
      },
    };
    if (CAPTURE) return film();
    requestAnimationFrame(frame);
  }).catch((error) => fail(error.message));
}

// Filming (capture=1): no loop, no start screen, no input. capture.js gets what it needs to
// place the camera and to have exact pictures drawn, and becomes fp.capture.
async function film() {
  const { setup } = await import('./capture.js');
  state.entered = ready = true;
  document.body.classList.add('capture', 'instant', 'shown', 'entered');
  $('overlay').hidden = true;
  window.fp.capture = setup({
    state, scene, proj, renderer, iface, critters, TIMES, STRIDE, WALK, EYE, hexGround, heading, yawOf, resolve,
    hexOf(u, v) {
      const tile = hexFromPx(...proj.groundToPx(u, v));
      return tile < 0 ? null : [tile % HEX_W, Math.floor(tile / HEX_W)];
    },
    // One picture of the state as it is, everything that moves by itself as at `time` seconds;
    // messages: what the bar's monitor holds. Returns what the middle of the view is on (scene.names index).
    draw(time, messages) {
      shown = render(0, time);
      state.lookingAt = shown[0].mode === 'fp' ? pick(...shown) : -1;
      iface.show(messages);
      hud();
      planKey = '';             // the minimap for exactly this place, not for the one it was last drawn for
      drawPlan();
      drawBar();
      return state.lookingAt;
    },
    describe(id) {
      return describe(id);
    },
  });
  console.log('[fp] ready');
}
