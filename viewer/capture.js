// Filming: exact pictures on request. Loaded by fp.js only with capture=1 in the URL; the
// page then runs no clock of its own, draws nothing until asked and takes no input. Every
// picture is a function of what is asked for and of nothing else (no dice, no wall clock),
// so a shot filmed twice gives the same pictures, and its frames can be drawn in any order,
// by several browsers at once. tools/fp/capture.py drives this and writes the frames.
//
//   fp.capture.info()             the page: map, size, GPU, the bar's size
//   fp.capture.shot(description)  define a shot (below); returns {frames, length, speed, warnings, ...}
//   fp.capture.frame(n, {sum})    draw frame n of the shot; the promise resolves when the picture is
//                                 on screen: {n, t, pose, looking, sum}
//   fp.capture.seek(t, {sum})     the same for a time in seconds
//   fp.capture.sample(t)          the camera of the shot at t, nothing drawn
//   fp.capture.draw(picture)      one picture without a shot: {pos | at, yaw, pitch, fov, eye,
//                                 clock, log: [messages], stride, sway} and any of the look options
//   fp.capture.play(speed)        run the shot against the wall clock, to look at it; stop() ends it
//
// A shot:
//   { "fps": 30, "duration": 3,
//     "look":   { "retro": true, "block": 0, "hud": true, "time": "day", "fov": 62, "eye": 1.15,
//                 "roofs": true, "solids": true, "cross": false, "plan": false, "anim": true,
//                 "seed": 0, "clock": 0 },
//     "camera": { "keys": [ {"t": 0, "pos": [hx, hy], "yaw": 76, "pitch": 0}, ... ],
//                 "ease": "inout", "heading": "keys", "target": [hx, hy, height], "ahead": 1.2,
//                 "bob": 0, "turn": "short" },
//     "events": [ {"t": 1, "say": "..."}, {"t": 2, "examine": true}, {"t": 2.5, "clear": true},
//                 {"t": 3, "set": {"time": "night"}} ] }
//
// look     retro: the small picture with square pixels, or the smooth one. block: retro, canvas
//          pixels to each of the picture's (0 = by the canvas's size; 2 at 1280x720 is the size of
//          the bar's pixels). hud: the game's interface bar. time: "day" | "dusk" | "night", a
//          number 0 (day) .. 1 (dusk) .. 2 (night) for a light in between, or [[t, value], ...]
//          to change it during the shot. fov: degrees from the top of the page to the bottom (the
//          bar covers the lowest part of that; the view above it is narrower). eye: its height in
//          units. cross: the crosshair and the name of what it is on. plan: the minimap. anim:
//          critters fidget, flames flicker. seed: another schedule of the fidgeting. clock: seconds
//          added to the shot's time for everything that moves by itself.
// camera   keys: where the eye is at which second. pos = a hex as in the page's URL, at = ground
//          units [u, v] (fp.pose() in a normal visit gives both), or move = [forward, right]:
//          so many units from the key before, forward being the way that key's yaw looks (a
//          known viewpoint and "six units on" need no coordinates). The eye goes through all of
//          them on a smooth curve (centripetal Catmull-Rom) at a speed without jumps: it is at
//          each key at that key's t; keys without t are spread by the distance between them, the
//          first at 0 and the last at the duration. yaw (degrees, 0 = up the game's screen,
//          clockwise), pitch (up positive), fov and eye are led through the keys that give them,
//          smoothly and without swinging past a value. ease: how the move starts and ends,
//          "inout" (from rest to rest), "in", "out" or "linear". heading "path": the eye looks
//          where it goes (`ahead` units along the curve) instead of along the keys' yaw.
//          target: it keeps looking at this point (a hex and a height above its floor) instead.
//          bob: the steps of a walk, 1 = as the page's head-bob, by the distance covered.
//          turn "written": yaw as written (0 to 360 is a full turn) instead of the short way round.
// events   say: a message into the bar's monitor from t on. examine: the message the page prints
//          for what the middle of the view is on at t (the exported inspection text). clear: an empty monitor.
//          set: look options that hold from t on.

import { HEX_W } from './geom.js';

const STEPS = 48;             // samples of every stretch of the curve, for its length

// ------------------------------------------------------------------ curves
// Values y at increasing times x, joined by cubics that never swing past a value (Fritsch and
// Carlson); `rest`: [at the first, at the last] the curve starts / ends with no speed.
function track(x, y, rest = [false, false]) {
  const n = x.length;
  if (n === 1) return { at: () => y[0], slope: () => 0 };
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(x[i + 1] - x[i]); d.push((y[i + 1] - y[i]) / h[i]); }
  const m = [rest[0] ? 0 : d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) { m.push(0); continue; }
    const a = 2 * h[i] + h[i - 1], b = h[i] + 2 * h[i - 1];
    m.push((a + b) / (a / d[i - 1] + b / d[i]));
  }
  m.push(rest[1] ? 0 : d[n - 2]);
  const find = (t) => {
    let i = 0;
    while (i < n - 2 && t >= x[i + 1]) i++;
    return i;
  };
  return {
    at(t) {
      t = Math.max(x[0], Math.min(x[n - 1], t));
      const i = find(t), s = (t - x[i]) / h[i], s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * y[i] + (s3 - 2 * s2 + s) * h[i] * m[i] + (-2 * s3 + 3 * s2) * y[i + 1] + (s3 - s2) * h[i] * m[i + 1];
    },
    slope(t) {
      if (t < x[0] || t > x[n - 1]) return 0;
      const i = find(t), s = (t - x[i]) / h[i], s2 = s * s;
      return (6 * s2 - 6 * s) * (y[i] - y[i + 1]) / h[i] + (3 * s2 - 4 * s + 1) * m[i] + (3 * s2 - 2 * s) * m[i + 1];
    },
  };
}

// The curve through ground points: {total, lengths: at each point, at(length) -> [u, v], dir(length)}.
// Centripetal Catmull-Rom, each stretch a Hermite cubic; points that repeat are a place to stand.
function curve(points) {
  const n = points.length, knot = [], tangent = [];
  for (let i = 0; i < n - 1; i++) knot.push(Math.sqrt(Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])));
  for (let i = 0; i < n; i++) {
    const before = i > 0 ? knot[i - 1] : 0, after = i < n - 1 ? knot[i] : 0;
    tangent.push([0, 1].map((k) => {
      const from = before ? (points[i][k] - points[i - 1][k]) / before : 0, to = after ? (points[i + 1][k] - points[i][k]) / after : 0;
      if (!before || !after) return from + to;          // an end, or beside a place to stand
      return (from * after + to * before) / (before + after);
    }));
  }
  const point = (i, s) => {
    const s2 = s * s, s3 = s2 * s, h = knot[i];
    return [0, 1].map((k) => (2 * s3 - 3 * s2 + 1) * points[i][k] + (s3 - 2 * s2 + s) * h * tangent[i][k]
      + (-2 * s3 + 3 * s2) * points[i + 1][k] + (s3 - s2) * h * tangent[i + 1][k]);
  };
  // Length along the curve at every sample.
  const table = [0], lengths = [0];
  for (let i = 0; i < n - 1; i++) {
    let last = points[i];
    for (let k = 1; k <= STEPS; k++) {
      const p = point(i, k / STEPS);
      table.push(table[table.length - 1] + Math.hypot(p[0] - last[0], p[1] - last[1]));
      last = p;
    }
    lengths.push(table[table.length - 1]);
  }
  const total = table[table.length - 1];
  const at = (length) => {
    if (n === 1 || length <= 0) return points[0].slice();
    if (length >= total) return points[n - 1].slice();
    let lo = 0, hi = table.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (table[mid] <= length) lo = mid; else hi = mid; }
    const part = table[hi] > table[lo] ? (length - table[lo]) / (table[hi] - table[lo]) : 0;
    const i = Math.min(n - 2, Math.floor(lo / STEPS));
    return point(i, (lo - i * STEPS + part) / STEPS);
  };
  // Unit direction of travel; beyond the ends the curve goes straight on.
  const dir = (length) => {
    const e = Math.min(0.02, total / 4), a = at(Math.max(0, Math.min(total - e, length))), b = at(Math.max(e, Math.min(total, length + e)));
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return d > 0 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [0, 0];
  };
  const beyond = (length) => {
    if (length <= total) return at(length);
    const end = at(total), d = dir(total);
    return [end[0] + d[0] * (length - total), end[1] + d[1] * (length - total)];
  };
  return { total, lengths, at, dir, beyond };
}

const LOOK = ['retro', 'block', 'hud', 'time', 'fov', 'eye', 'roofs', 'solids', 'cross', 'plan', 'anim', 'seed', 'clock'];

export function setup(ctx) {
  const { state, scene, proj, renderer, iface } = ctx;
  const canvas = renderer.canvas;
  const defaults = { retro: state.retro, block: state.block, hud: state.hud, time: state.time, fov: state.fov, eye: state.eye,
                     roofs: state.roofs, solids: state.solids, cross: false, plan: state.plan, anim: state.anim, seed: state.seed, clock: 0 };
  let shot = null;              // the shot as defined: {fps, duration, frames, look, events, camera: sampler}
  let playing = 0;

  const ground = (key) => {
    if (key.at) return [+key.at[0], +key.at[1]];
    if (key.pos) return ctx.hexGround(key.pos[1] * HEX_W + key.pos[0]);
    throw new Error('a camera key needs "pos": [hx, hy] or "at": [u, v]');
  };
  const degrees = (radians) => radians * 180 / Math.PI;
  const round = (x, digits = 4) => +x.toFixed(digits);

  // ----------------------------------------------------------------- look
  const lightValue = (value) => (typeof value === 'string' ? ctx.TIMES.indexOf(value) : +value);

  function setLook(look, t = 0) {
    state.retro = !!look.retro;
    state.block = +look.block || 0;
    state.hud = !!look.hud;
    state.fov = +look.fov;
    state.eye = +look.eye;
    state.roofs = !!look.roofs;
    state.solids = !!look.solids;
    state.plan = !!look.plan;
    state.anim = !!look.anim;
    state.seed = +look.seed || 0;
    document.body.classList.toggle('cross', !!look.cross);
    let light = look.time;
    if (Array.isArray(light)) {                   // [[t, value], ...]: straight from one to the next
      const keys = light.map(([at, value]) => [+at, lightValue(value)]);
      let i = 0;
      while (i < keys.length - 2 && t >= keys[i + 1][0]) i++;
      const [a, b] = [keys[i], keys[Math.min(keys.length - 1, i + 1)]];
      const f = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
      light = a[1] + (b[1] - a[1]) * f;
    }
    if (typeof light === 'string') {
      if (!ctx.TIMES.includes(light)) throw new Error(`time: "${light}" is none of ${ctx.TIMES.join(', ')}`);
      state.time = light;
      state.blend = null;
    } else {
      state.blend = +light;
    }
  }

  // The look at t seconds of the shot: its own, and what events have set since.
  function lookAt(t) {
    const look = { ...shot.look };
    for (const event of shot.events) if (event.set && event.t <= t) Object.assign(look, event.set);
    return look;
  }

  function messagesAt(t) {
    let messages = [];
    for (const event of shot.events) {
      if (event.t > t) continue;
      if (event.clear) messages = [];
      if (event.text != null) messages.push(event.text);
    }
    return messages;
  }

  // --------------------------------------------------------------- camera
  // -> sample(t): {at, yaw, pitch, fov, eye, length, speed, stride, sway} (yaw, pitch in degrees)
  function camera(description, duration, look) {
    const keys = (description.keys || []).map((key) => ({ ...key }));
    if (!keys.length) throw new Error('camera.keys is empty');
    const points = [];
    let facing = null;                              // the yaw last written
    keys.forEach((key, i) => {
      if (key.move) {
        if (!i || facing === null) throw new Error(`camera key ${i}: "move" needs a key before it, and a yaw to move along`);
        const f = ctx.heading(facing * Math.PI / 180), r = ctx.heading((facing + 90) * Math.PI / 180), [forward, right = 0] = key.move;
        points.push([points[i - 1][0] + f[0] * forward + r[0] * right, points[i - 1][1] + f[1] * forward + r[1] * right]);
      } else {
        points.push(ground(key));
      }
      if (key.yaw != null) facing = +key.yaw;
    });
    const path = curve(points), n = keys.length;
    // Times: as given; the rest by the distance covered (evenly where nothing moves).
    if (keys[0].t == null) keys[0].t = 0;
    if (keys[n - 1].t == null) keys[n - 1].t = n > 1 ? duration : keys[0].t;
    for (let i = 1; i < n - 1; i++) {
      if (keys[i].t != null) continue;
      let j = i + 1;
      while (keys[j].t == null) j++;
      const span = path.lengths[j] - path.lengths[i - 1];
      for (let k = i; k < j; k++) {
        const share = span > 0 ? (path.lengths[k] - path.lengths[i - 1]) / span : (k - i + 1) / (j - i + 1);
        keys[k].t = keys[i - 1].t + (keys[j].t - keys[i - 1].t) * share;
      }
      i = j;
    }
    const times = keys.map((key) => +key.t);
    for (let i = 1; i < n; i++) if (!(times[i] > times[i - 1])) throw new Error(`camera key ${i}: t must be later than the key before (${times[i - 1]} then ${times[i]})`);
    const ease = description.ease || 'inout';
    if (!['inout', 'in', 'out', 'linear'].includes(ease)) throw new Error(`camera.ease: "${ease}"?`);
    const rest = [ease === 'inout' || ease === 'in', ease === 'inout' || ease === 'out'];
    const along = track(times, path.lengths, rest);
    // A value led through the keys that give it.
    const led = (name, fallback, prepare = (values) => values) => {
      const given = keys.map((key, i) => [times[i], key[name]]).filter(([, value]) => value != null);
      if (!given.length) return { at: () => fallback, slope: () => 0 };
      return track(given.map(([t]) => t), prepare(given.map(([, value]) => +value)), rest);
    };
    const short = (values) => {                    // each yaw the short way round from the one before
      for (let i = 1; i < values.length; i++) values[i] = values[i - 1] + ((values[i] - values[i - 1]) % 360 + 540) % 360 - 180;
      return values;
    };
    const yaw = led('yaw', null, description.turn === 'written' ? undefined : short);
    const pitch = led('pitch', 0), fov = led('fov', look.fov), eye = led('eye', look.eye);
    const heading = description.heading || 'keys', ahead = description.ahead ?? 1.2, bob = +description.bob || 0;
    let target = null;
    if (description.target) {
      const [hx, hy, height = 0.8] = description.target;
      target = [...ctx.hexGround(hy * HEX_W + hx), height];
    }
    if (!target && heading === 'path' && !(path.total > 0)) throw new Error('camera.heading "path" needs a camera that moves');
    if (!target && heading !== 'path' && yaw.at(0) === null) throw new Error('camera: give the keys a yaw, or a target, or heading "path"');

    const sample = (t) => {
      const length = along.at(t), speed = along.slope(t), at = path.at(length), eyeAt = eye.at(t);
      let yawAt, pitchAt = pitch.at(t);
      if (target) {
        yawAt = degrees(ctx.yawOf([target[0] - at[0], target[1] - at[1]]));
        pitchAt = degrees(Math.atan2(target[2] - eyeAt, Math.hypot(target[0] - at[0], target[1] - at[1])));
      } else if (heading === 'path') {
        const to = path.beyond(length + ahead);
        yawAt = degrees(ctx.yawOf([to[0] - at[0], to[1] - at[1]]));
      } else {
        yawAt = yaw.at(t);
      }
      return { at, yaw: yawAt, pitch: pitchAt, fov: fov.at(t), eye: eyeAt, length, speed,
               stride: length / ctx.STRIDE * 2 * Math.PI, sway: bob * Math.max(0, Math.min(1, speed / ctx.WALK)) };
    };
    return { sample, path, times, bob, points };
  }

  function place(pose) {
    [state.u, state.v] = pose.at ? [+pose.at[0], +pose.at[1]] : ground(pose);
    state.centerTile = null;
    state.yaw = (+pose.yaw || 0) * Math.PI / 180;
    state.pitch = (+pose.pitch || 0) * Math.PI / 180;
    if (pose.fov != null) state.fov = +pose.fov;
    if (pose.eye != null) state.eye = +pose.eye;
    state.stride = +pose.stride || 0;
    state.sway = +pose.sway || 0;
    state.bob = state.sway > 0;
  }

  // ------------------------------------------------------------- pictures
  // The picture is on screen once the browser has shown a frame after the one it was drawn in.
  const presented = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  // Canvas rows the bar covers.
  const barRows = () => Math.round(state.lift * canvas.height);

  // Canvas rows, from the top, that the crosshair, the name under it or the minimap lie over: [[from, to), ...].
  const covered = () => {
    const k = canvas.height / canvas.clientHeight, list = [];
    for (const id of ['cross', 'label', 'plan']) {
      const element = document.getElementById(id), box = element.getBoundingClientRect();
      if (getComputedStyle(element).display === 'none' || !(box.width > 0 && box.height > 0)) continue;
      list.push([Math.max(0, Math.floor(box.top * k) - 1), Math.ceil(box.bottom * k) + 1]);
    }
    return list;
  };

  // A number of the picture as just drawn: over all pixels of the rows above the bar that no
  // overlay lies over (skip), counted from the top left, (R + 3 G + 5 B) * (1 + (31 x + 17 y)
  // mod 1024), modulo 2^32. capture.py takes the same number of its screenshot; if they agree
  // the screenshot is this picture and no other.
  let pixels = null;
  function checksum() {
    const gl = renderer.gl, width = canvas.width, rows = canvas.height - barRows(), skip = covered();
    if (!pixels || pixels.length !== width * canvas.height * 4) pixels = new Uint8Array(width * canvas.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, canvas.height - rows, width, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0;
    for (let row = 0; row < rows; row++) {
      const y = rows - 1 - row;                    // readPixels starts at the bottom
      if (skip.some(([from, to]) => y >= from && y < to)) continue;
      let i = row * width * 4, weight = 17 * y;
      for (let x = 0; x < width; x++, i += 4, weight += 31) sum += (pixels[i] + 3 * pixels[i + 1] + 5 * pixels[i + 2]) * (1 + (weight & 1023));
    }
    return { sum: sum % 2 ** 32, rows, width, skip };
  }

  function drawShot(t) {
    const look = lookAt(t), pose = shot.camera.sample(t);
    setLook(look, t);
    place(pose);
    const looking = ctx.draw(t + (+look.clock || 0), messagesAt(t));
    return { pose, looking };
  }

  const report = (pose) => {      // for reading: rounded, the hex one stands on
    return { at: pose.at.map((c) => round(c)), hex: ctx.hexOf(pose.at[0], pose.at[1]), yaw: round(((pose.yaw % 360) + 360) % 360, 3), pitch: round(pose.pitch, 3),
             fov: round(pose.fov, 3), eye: round(pose.eye, 3), length: round(pose.length), speed: round(pose.speed) };
  };
  const api = {
    version: 1,

    info() {
      const gl = renderer.gl, names = gl.getExtension('WEBGL_debug_renderer_info');
      const bar = iface.ready && state.lift > 0 ? iface.place(canvas.clientWidth, canvas.clientHeight, devicePixelRatio || 1) : null;
      return {
        map: scene.map, title: scene.place, indoor: !!scene.indoor,
        page: [canvas.clientWidth, canvas.clientHeight], canvas: [canvas.width, canvas.height], dpr: devicePixelRatio,
        picture: renderer.buffers ? [renderer.buffers.width, renderer.buffers.height, renderer.buffers.block] : null,
        bar: bar && { scale: bar.scale, height: bar.height, rows: barRows() },
        gpu: names ? gl.getParameter(names.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        look: { ...defaults }, walk: ctx.WALK, eye: ctx.EYE,
      };
    },

    shot(description) {
      api.stop();
      const fps = +description.fps || 30, duration = +description.duration;
      if (!(duration > 0)) throw new Error('shot.duration must be more than 0 seconds');
      const unknown = Object.keys(description.look || {}).filter((name) => !LOOK.includes(name));
      if (unknown.length) throw new Error(`look: unknown ${unknown.join(', ')} (there are ${LOOK.join(', ')})`);
      const look = { ...defaults, ...description.look };
      const events = (description.events || []).map((event) => ({ ...event, t: +event.t || 0 })).sort((a, b) => a.t - b.t);
      for (const event of events) {
        const bad = Object.keys(event.set || {}).filter((name) => !LOOK.includes(name));
        if (bad.length) throw new Error(`event at ${event.t}: unknown ${bad.join(', ')}`);
        if (event.say != null) event.text = String(event.say);
      }
      shot = { fps, duration, frames: Math.round(duration * fps), look, events, camera: camera(description.camera || {}, duration, look) };
      // What an "examine" prints is what the middle of the view is on at that moment.
      for (const event of events) {
        if (!event.examine) continue;
        event.text = ctx.describe(drawShot(event.t).looking);
      }
      // Where the eye is nearer to a wall or a thing than someone walking could be.
      const warnings = [];
      let inside = null;
      for (let n = 0; n <= shot.frames; n++) {
        const t = n / fps, { at } = shot.camera.sample(t), [u, v] = ctx.resolve(at[0], at[1]);
        const push = Math.hypot(u - at[0], v - at[1]);
        if (push > 0.02 && !inside) inside = { from: round(t, 3), push: 0 };
        if (inside && push > 0.02) inside.push = Math.max(inside.push, round(push, 3));
        if (inside && (push <= 0.02 || n === shot.frames)) {
          warnings.push(`camera inside or against something solid from ${inside.from} s to ${round(t, 3)} s (up to ${inside.push} units deep)`);
          inside = null;
        }
      }
      const { path, times } = shot.camera;
      let fastest = 0;
      for (let n = 0; n <= shot.frames; n++) fastest = Math.max(fastest, shot.camera.sample(n / fps).speed);
      drawShot(0);
      return {
        frames: shot.frames, fps, duration, length: round(path.total, 3),
        keys: times.map((t, i) => ({ t: round(t, 3), at: shot.camera.points[i].map((c) => round(c, 3)), hex: ctx.hexOf(...shot.camera.points[i]) })),
        speed: { mean: times.length > 1 ? round(path.total / (times[times.length - 1] - times[0]), 3) : 0, fastest: round(fastest, 3), walk: ctx.WALK },
        messages: events.filter((event) => event.text != null).map((event) => [event.t, event.text]),
        warnings,
      };
    },

    sample(t) {
      if (!shot) throw new Error('no shot defined');
      return report(shot.camera.sample(t));
    },

    async seek(t, { sum = false } = {}) {
      if (!shot) throw new Error('no shot defined');
      const { pose, looking } = drawShot(t);
      const check = sum ? checksum() : null;
      await presented();
      return { t: round(t, 6), pose: report(pose), looking: looking < 0 ? null : scene.names[looking], ...check };
    },

    async frame(n, options) {
      if (!shot) throw new Error('no shot defined');
      return { n, ...await api.seek(n / shot.fps, options) };
    },

    async draw(picture = {}, { sum = false } = {}) {
      api.stop();
      const look = { ...defaults };
      for (const name of LOOK) if (picture[name] != null) look[name] = picture[name];
      setLook(look, 0);
      place({ ...picture, fov: picture.fov ?? look.fov, eye: picture.eye ?? look.eye });
      const looking = ctx.draw(+picture.clock || 0, picture.log || []);
      const check = sum ? checksum() : null;
      await presented();
      return { looking: looking < 0 ? null : scene.names[looking], ...check };
    },

    // The shot against the wall clock, over and over (for a look at it; frames may be skipped).
    play(speed = 1) {
      if (!shot) throw new Error('no shot defined');
      api.stop();
      const run = ++playing, from = performance.now();
      const step = (now) => {
        if (run !== playing) return;
        drawShot(((now - from) / 1000 * speed) % shot.duration);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },

    stop() { playing++; },
  };
  return api;
}
