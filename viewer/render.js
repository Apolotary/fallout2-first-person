// WebGL2 renderer: one vertex layout for every textured quad, three cameras.
//
// Vertex = position (3), card offset (3), atlas texel (2), wall (1), twin (2), kind (1).
//   kind 0  static quad (floor decals, roofs, the ground). Floor and roof tiles
//           are static quads of the TILES variant of the program: their texture
//           is one layer of an array texture, the layer number rides in offset.x.
//   kind 1  sprite card: its four vertices share one position and are spread
//           along uRight / uUp / uToward (see card() in geom.js), so the same
//           buffer serves iso mode (the ground directions that are horizontal /
//           downwards on the game's screen), the top view and the first-person
//           camera (uRight = camera right; there twin.x replaces the offset
//           along uUp and nothing goes along uToward: the card stands upright).
//   kind 2  wall: twin = its unit normal on the ground (for lighting only).
//   kind 3  wall top: offset = the way back, along the game camera's ray, to the
//           point of the wall's front plane that the texel was painted on.
//   kind 4  face of a solid or a form (see "Solids"): offset = its normal, twin.y = as for cards,
//           twin.x = how much darker it is than its texels (the inside of a tent).
//   kind 5  sheet of a plant: position = where it grows, offset = the way from there to the corner.
//
// Walls are solid (tools/fp/boxes.py). The game's art is a picture taken by one
// camera, and a texel of it may be put on any surface as long as that surface
// point lies on the camera's ray through the texel: the game's camera then
// still sees every pixel where the game drew it, and every other eye sees a
// thing with depth. A wall's picture stands on the wall's front plane, and what
// rises above the wall's height there is really its top face, so those rows
// are laid back along the camera's rays onto the horizontal plane at that
// height (wallFront). For the game's camera the top keeps the depth of the
// plane it came from: the game paints sprite over sprite, and what it painted
// a wall's picture over (a lamp post right behind the wall) must stay hidden.
// Surfaces the game's camera cannot see - backs, ends - are drawn in first
// person only, with pictures the exporter chose for them. All of these are
// one-sided: from inside a slab one must not see its faces.
//
// Solids: furniture and other deep scenery is a box or a drum in first person
// (tools/fp/props.py chooses them), textured by the same rule: a point of the
// solid shows the pixel of the sprite that it lands on from the game's camera.
// That is an affine function of the point, so every flat face only needs the
// texel of its corners (texelAt), and faces are clipped to the sprite's
// rectangle so that none ever reads its neighbours in the atlas (clip). The
// faces that camera sees - top, the two near sides, the insides of a box's far
// sides above its top - carry the sprite itself, the others its mirror image:
// a far side shows what the near side opposite shows (drums: see solid()). The
// game's views draw the faces it sees over the object's card, at the card's
// depth: there they change nothing, which is the test that the projection is right.
//
// Forms are the same idea for what is no box and no drum: tents, set pieces
// (tools/fp/tents.py, sets.py). The exporter hands over flat faces and one picture
// per form; a face shows the pixels its points land on, or those of other points
// that the exporter names (the far side of a thing: what its near side shows).
// Faces are one-sided, corners counter-clockwise seen from outside. First person
// draws forms instead of the walls, roof squares and cards they stand for; the
// game's views do not know them (but see `proxies` in draw()).
//
// Depth of cards: a card faces the viewer - leaning over its footprint in the
// game's views, upright on it in first person (card() in geom.js; twin.x = how
// high) - but its depth is that of an upright plane through its hex, at right
// angles to the grid axis the camera looks along (twin.y = the way to that
// plane along v; uCardNormal = the axis). The fragment gets the depth of
// the point where its view ray meets that plane. For the game's camera this is
// the plane of the hex row, so sprites hide each other and stand in front of
// or behind walls exactly as the game's hex-by-hex painting has it (rowPlane
// in geom.js); in first person it keeps a sprite from being cut in two by the
// wall it stands next to. A card whose hex lies inside a wall is something that
// hangs in or on it (Vault City's round windows, signs): in first person its
// depth plane comes `wall` (the slab's thickness and a bit) towards the eye, so
// that it shows on whichever face of the wall is looked at.
//
// Textures hold premultiplied colour (tools/fp/atlas.py: a transparent texel
// is black): whatever the filter averages, colour / alpha is the mean colour of
// the opaque texels alone, so no dark or foreign fringe appears around sprites,
// at any mip level. With nearest sampling alpha is 1 and nothing changes.
//
// Two looks share the geometry. Iso and top view show the game's pixels
// unchanged: nearest sampling, no light, no fog (uFp = 0). First person
// (uFp = 1) adds what a walk through the map needs: mip-mapped textures whose
// texels stay crisp up close, the baked light image (tools/fp/light.py),
// distance fog in the colour of the horizon, a sky.
//
// First person is drawn into a texture and that is put on the canvas (present), in one
// of two ways. The art is small - a wall is 96 pixels high - so on a full-size picture a
// texel is a speck in the distance and a slab up close, and things of different texel
// size stand side by side. `retro` draws the picture RETRO_LINES rows high or so, the size
// at which a texel across a room is about one pixel, and shows every pixel of it as a
// square of `block` canvas pixels: a whole number, so that all are the same size.
// `smooth` draws at the canvas's size with multisampling, and lays a fine grain over
// texels that are many pixels wide (uGrain). The game's views go straight to the canvas,
// pixel for pixel. (Reducing the retro picture to the game's 228 colours with a dither
// pattern was tried and left out: skies and fog, which the palette has no ramps for,
// turned into a purple weave, and dark rooms into mud.)

import { card, rowPlane } from './geom.js';

const STRIDE = 12;
const MIP_LEVELS = 3;         // of the sprite atlas: its images are EXTRUDE = 4 texels apart at least (tools/fp/atlas.py)
const WALL_LIGHT_AT = 0.14;   // a wall face takes its light from the floor this far in front of it (units)
const GLOW_RADIUS = 0.75;     // of the halo around a flame or lamp (units)
const TEXEL_EDGE = '0.3';     // share of a hugely magnified texel that blends into its neighbours
const FOOT_SHADE = ['0.16', '0.22', '0.3'];   // how much darker cards, solids and walls are where they meet the floor
const CARD_NEAR = ['0.2', '0.42'];    // a sprite card fades out between these distances from the eye (units)
const CAST_SHADOW = 0.62;     // opacity of the shadows that were painted into sprites, lying on the floor
const EXIT_GRID = 0.28;       // opacity of the hatching that marks where a map is left
const CEILING = 0.58;         // first person sees roofs from below: this much of their brightness
const EAVES = 0.3;            // roofs reach this far beyond their squares (units): wall faces stand up to 0.28 inside
                              // the next square, and the gap would show sky from indoors
const EAVES_INSET = 4;        // texels
const CARD_SKIN = 0.03;       // units a card that hangs in a wall stands off its face
const DRUM_SIDES = 16;        // faces round a drum
export const RETRO_LINES = 270;      // rows of the retro picture, about: the canvas's shorter side over a whole number
const SAMPLES = 4;            // smooth: multisampling
const GRAIN = 0.16;           // smooth: how much darker or brighter the grain makes a huge texel at most
const OVER_CARD = 2e-5;       // units by which a solid is nearer than its card for the game's cameras (a fifth of
                              // what separates two sprites on one hex, proj.stack)

const VS = `
in vec3 aPos;
in vec3 aOff;      // along uRight, uUp, uToward; TILES: x = array layer
in vec3 aUv;       // texels; z = wall, see "Depth of cards"
in vec3 aTwin;     // xy: see kind, z = kind
uniform mat4 uViewProj;
uniform vec3 uRight, uUp, uToward;
uniform vec3 uCardNormal; // horizontal axis the depth planes of cards are perpendicular to
uniform vec4 uRay;        // w = 1: all view rays run along xyz (parallel cameras); w = 0: they start at uEye
uniform vec3 uEye;
uniform vec2 uSunAt;      // ground direction towards the sun
out vec2 vUv;
out vec3 vWorld;
out vec2 vLightAt;        // where on the ground this vertex takes its light from
out vec3 vShade;          // brightness factor; how much darker at the floor (walls: more than 0.25); how solid
                          // (cards fade out right in front of the eye)
#ifdef TILES
out float vLayer;
#endif
void main() {
  vUv = aUv.xy;
  vShade = vec3(1.0, 0.0, 1.0);
#ifdef TILES
  vWorld = aPos;
  vLayer = aOff.x;
  vLightAt = aPos.xy;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
#else
  vec2 stand = aOff.yz;     // of a card: height, and how far its edge leans towards the viewer
  if (aTwin.z > 0.5 && aTwin.z < 1.5 && uRay.w < 0.5) {
    // First person: a card stands upright (aTwin.x = that height), and thins out
    // at arm's length instead of filling the screen.
    stand = vec2(aTwin.x, 0.0);
    vShade.z = smoothstep(${CARD_NEAR[0]}, ${CARD_NEAR[1]}, distance(uEye.xy, aPos.xy));
  }
  vWorld = aTwin.z > 2.5 ? aPos : aPos + uRight * aOff.x + uUp * stand.x + uToward * stand.y;
  vLightAt = vWorld.xy;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
  if (aTwin.z > 4.5) {
    // A plant's sheet stands where it is put, lit like a card and thinning out at arm's length.
    vWorld = aPos + aOff;
    vLightAt = aPos.xy;
    vShade.yz = vec2(${FOOT_SHADE[0]}, smoothstep(${CARD_NEAR[0]}, ${CARD_NEAR[1]}, distance(uEye.xy, aPos.xy)));
    gl_Position = uViewProj * vec4(vWorld, 1.0);
  } else if (aTwin.z > 3.5) {
    // A face of a solid, a little brighter towards the sky and the sun. The game's
    // cameras see it at the depth of its object's card: the plane v = aPos.y + aTwin.y.
    vLightAt += aOff.xy * ${WALL_LIGHT_AT};
    vShade.xy = vec2((0.92 + 0.08 * aOff.z + 0.06 * dot(aOff.xy, uSunAt)) * (1.0 - aTwin.x), ${FOOT_SHADE[1]});
    if (uRay.w > 0.5) gl_Position.z = (uViewProj * vec4(aPos + uRay.xyz * (aTwin.y / uRay.y), 1.0)).z;
  } else if (aTwin.z > 2.5) {
    vShade.x = 0.87;
    if (uRay.w > 0.5) gl_Position.z = (uViewProj * vec4(aPos + aOff, 1.0)).z;
  } else if (aTwin.z > 1.5) {
    // A wall is lit by what is on the side it is seen from (doors and signs are
    // seen from both), a little brighter where it faces the sun.
    vec2 normal = dot(aTwin.xy, uEye.xy - vWorld.xy) < 0.0 ? -aTwin.xy : aTwin.xy;
    vLightAt += normal * ${WALL_LIGHT_AT};
    vShade.xy = vec2(0.87 + 0.13 * dot(normal, uSunAt), ${FOOT_SHADE[2]});
  } else if (aTwin.z > 0.5) {
    vLightAt = aPos.xy;
    vShade.y = ${FOOT_SHADE[0]};
    vec3 ray = uRay.w > 0.5 ? uRay.xyz : vWorld - uEye;
    vec3 on = aPos + vec3(0.0, aTwin.y, 0.0);             // a point of the depth plane
    if (uRay.w < 0.5) on -= uCardNormal * aUv.z * sign(dot(uCardNormal, on - uEye));
    float along = dot(uCardNormal, ray);
    float t = abs(along) > 0.00001 ? dot(uCardNormal, on - vWorld) / along : 0.0;
    if (uRay.w < 0.5) t = clamp(t, -0.75, 3.0);      // never behind the eye, never absurdly far
    vec4 q = uViewProj * vec4(vWorld + ray * t, 1.0);
    gl_Position.z = q.z / q.w * gl_Position.w;
  }
#endif
}`;

const FS = `
precision highp float;
#ifdef TILES
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform vec2 uClamp;      // texels: lookups stay in this range of the tile (eaves repeat its edge)
in float vLayer;
#else
uniform sampler2D uTex;
#endif
uniform sampler2D uLight; // R lamps, G daylight, B floor shade, over the 100 x 100 units of the map
uniform vec2 uTexel;      // 1 / texture size
uniform vec4 uFlat;       // a > 0: untextured colour
uniform vec3 uTint;
uniform float uCut;       // alpha below this is a hole
uniform float uFp;        // 0: the game's pixels unchanged
uniform float uGlow;      // 1: a light of its own (added to the picture, only fog dims it)
uniform float uFloor;     // 1: the floor shade applies
uniform vec3 uSky, uShade, uLamp;   // light under the open sky, under a roof, added by lamps
uniform vec3 uEye;
uniform vec4 uFog;        // rgb, density
uniform float uWallTop;   // height of the roofs: walls are shaded where they meet them
uniform sampler2D uGrain; // smooth: a patch of soft noise that repeats
uniform float uGrainBy;   // how much of it shows, 0 = none
uniform float uColour;    // how much colour is left in what only the sky lights (night: little)
uniform float uRetro;     // 1: the small picture
in vec2 vUv;
in vec3 vWorld;
in vec2 vLightAt;
in vec3 vShade;
out vec4 colour;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c = uFlat;
  if (uFlat.a <= 0.0) {
    vec2 at = vUv;
    if (uFp > 0.5) {
      // Magnified, every texel stays a block but blends into its neighbour over one
      // screen pixel (no crawling edges), or over ${TEXEL_EDGE} of its width when it
      // is huge (nose to a wall); minified this changes nothing and the mip levels take over.
      // The retro picture has pixels to spare for none of that: there the blend narrows with
      // the cube of the magnification, so a texel twice a pixel wide already has hard edges.
      vec2 seam = floor(vUv + 0.5), wide = min(fwidth(vUv), vec2(1.0));
      vec2 blend = uRetro > 0.5 ? max(wide * wide * wide, vec2(0.001)) : max(wide, vec2(${TEXEL_EDGE}));
      at = seam + clamp((vUv - seam) / blend, -0.5, 0.5);
    }
#ifdef TILES
    c = textureGrad(uTex, vec3(clamp(at, uClamp.x, uClamp.y) * uTexel, vLayer), dFdx(vUv) * uTexel, dFdy(vUv) * uTexel);
#else
    c = textureGrad(uTex, at * uTexel, dFdx(vUv) * uTexel, dFdy(vUv) * uTexel);
#endif
  }
  if (c.a < uCut || vShade.z < hash(gl_FragCoord.xy)) discard;
  vec3 rgb = c.rgb / max(c.a, 0.004) * uTint;         // premultiplied -> colour
  if (uFp > 0.5) {
    if (uGrainBy > 0.0 && uFlat.a <= 0.0) {
      // A texel many pixels wide is a flat slab. Two layers of soft noise, 3 and 11 cells to
      // the texel, give the eye something of its own size to rest on; their mip levels fade
      // them out by themselves where they would be finer than the screen.
      vec2 wide = fwidth(vUv);
      float huge = smoothstep(0.4, 0.1, max(wide.x, wide.y));      // from 2.5 pixels a texel to 10
      float grain = texture(uGrain, vUv * 0.047).r + texture(uGrain, vUv.yx * 0.172 + 0.37).r - 1.0;
      rgb *= 1.0 + uGrainBy * huge * grain;
    }
    float fog = 1.0 - exp(-pow(distance(vWorld, uEye) * uFog.a, 1.6));
    if (uGlow > 0.5) {
      rgb *= 1.0 - fog;
    } else {
      vec3 baked = texture(uLight, vLightAt * 0.01).rgb;
      // Whatever stands is darker towards the floor it stands on, and walls under the eaves.
      float stands = 1.0 - vShade.y * smoothstep(0.45, 0.0, vWorld.z);
      if (vShade.y > 0.25) stands *= 1.0 - 0.4 * smoothstep(uWallTop - 0.16, uWallTop, vWorld.z);
      float shade = vShade.x * mix(1.0, baked.b, uFloor) * stands;
      // The sky's light, in which at night things have little colour of their own, then the lamps'.
      vec3 pale = mix(vec3(dot(rgb, vec3(0.3, 0.59, 0.11))), rgb, uColour);
      vec3 lit = pale * mix(uShade, uSky, baked.g) + rgb * uLamp * baked.r;
      rgb = mix(min(lit, rgb * 1.2) * shade, uFog.rgb, fog);
    }
    rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;      // dither: no bands in the fog
  }
  colour = vec4(rgb, 1.0);
}`;

const SKY_VS = `
in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// The sky is a function of the view ray: haze at the horizon, a gradient to the
// zenith, the sun's glow, stars at night and two ridge lines of far mesas (a
// noise function of the compass direction, flattened into table mountains).
const SKY_FS = `
precision highp float;
uniform vec3 uCamRight, uCamUp, uCamForward;      // camera axes, scaled by tan(half fov)
uniform vec3 uZenith, uHorizon, uSunDir, uSunColour, uMesa;
uniform float uStars;
in vec2 vNdc;
out vec4 colour;
float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// Smooth noise on a circle of "cells" lattice points.
float ring(float turn, float cells, float seed) {
  float x = turn * cells, i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(mod(i, cells) + seed), hash(mod(i + 1.0, cells) + seed), f);
}
float ridge(float turn, float seed) {
  float table = smoothstep(0.42, 0.56, ring(turn, 14.0, seed)) * (0.55 + 0.45 * ring(turn, 5.0, seed + 40.0));
  return table + 0.22 * ring(turn, 70.0, seed + 80.0) + 0.08 * ring(turn, 260.0, seed + 120.0);
}
void main() {
  vec3 d = normalize(uCamForward + uCamRight * vNdc.x + uCamUp * vNdc.y);
  float up = d.z / max(length(d.xy), 0.0001);              // tangent of the elevation
  float turn = atan(d.y, d.x) / 6.2831853 + 0.5;
  vec3 c = mix(uHorizon, uZenith, 1.0 - exp(-max(up, 0.0) * 3.2));
  float sun = max(dot(d, uSunDir), 0.0);
  c += uSunColour * (0.22 * pow(sun, 5.0) + 0.5 * pow(sun, 90.0) + smoothstep(0.9993, 0.9996, sun));
  if (uStars > 0.0 && up > 0.0) {
    vec2 cell = vec2(turn * 420.0, up * 130.0);
    vec2 spot = fract(cell) - 0.5;
    float star = step(0.985, hash2(floor(cell))) * smoothstep(0.35, 0.0, length(spot));
    c += uStars * star * (0.4 + 0.6 * hash2(floor(cell) + 7.0)) * smoothstep(0.0, 0.15, up);
  }
  if (uMesa.r >= 0.0) {
    if (up < 0.028 * ridge(turn, 3.0)) c = mix(uMesa, uHorizon, 0.78);
    if (up < 0.045 * ridge(turn + 0.37, 17.0) - 0.008) c = mix(uMesa, uHorizon, 0.6);
  }
  if (up < 0.0) c = uHorizon;
  colour = vec4(c + (hash2(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
}`;

// Puts the first-person picture on the canvas: every texel of it as a square of uBlock.z canvas pixels.
const PRESENT_FS = `
precision highp float;
uniform sampler2D uScene;
uniform vec3 uBlock;          // xy: canvas pixels of the picture cut off at the lower left, z: canvas pixels per texel
out vec4 colour;
void main() {
  colour = vec4(texelFetch(uScene, ivec2((gl_FragCoord.xy + uBlock.xy) / uBlock.z), 0).rgb, 1.0);
}`;

// Moods: every colour of the first-person look in one place. sun = [compass
// degrees, clockwise from the top of the game's screen; elevation]; sky / shade
// = light under the open sky / under a roof; lamp = what a fully lit spot of
// the map's own light sources adds; mesa: false = no mountains (underground);
// colour: how much of their own colour things keep in the sky's light (default: all).
export const MOODS = {
  day: { zenith: [0.27, 0.43, 0.66], horizon: [0.80, 0.71, 0.56], sun: [250, 38], sunColour: [1.0, 0.92, 0.72],
         sky: [1.03, 1.0, 0.94], shade: [0.72, 0.72, 0.76], lamp: [0.46, 0.36, 0.2], fog: 0.021,
         mesa: [0.42, 0.27, 0.2], stars: 0, glow: 0.35 },
  dusk: { zenith: [0.15, 0.17, 0.36], horizon: [0.88, 0.5, 0.27], sun: [285, 3.5], sunColour: [1.0, 0.5, 0.2],
          sky: [0.8, 0.6, 0.5], shade: [0.46, 0.4, 0.42], lamp: [0.68, 0.5, 0.28], fog: 0.025,
          mesa: [0.2, 0.11, 0.13], stars: 0.15, glow: 0.7 },
  night: { zenith: [0.035, 0.06, 0.15], horizon: [0.13, 0.19, 0.33], sun: [120, 52], sunColour: [0.5, 0.56, 0.7],
           sky: [0.47, 0.58, 0.88], shade: [0.24, 0.3, 0.47], lamp: [0.98, 0.74, 0.42], fog: 0.028,
           mesa: [0.03, 0.04, 0.09], stars: 1, glow: 1, colour: 0.4 },
};

// Underground there is no sky; `ambient` is the level the map script sets (scene.ambient).
export function underground(ambient) {
  const dark = [0.012, 0.012, 0.016], level = [0.92 * ambient, 0.95 * ambient, ambient];
  return { zenith: dark, horizon: dark, sun: [0, 90], sunColour: [0, 0, 0], sky: level, shade: level,
           lamp: [1, 0.8, 0.5].map((c) => c * (1.05 - ambient)), fog: 0.045, mesa: false, stars: 0, glow: 1.1 - ambient };
}

function compile(gl, vs, fs, defines = '') {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, `#version 300 es\n${defines}${source}`);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  ['aPos', 'aOff', 'aUv', 'aTwin'].forEach((name, i) => gl.bindAttribLocation(program, i, name));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(program, i).name;
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}
const ATTRIBUTES = [[3, 0], [3, 12], [3, 24], [3, 36]];     // size, byte offset of aPos, aOff, aUv, aTwin

// Collects quads. A corner is [x, y, z, texX, texY] followed, for a sprite
// card, by [offRight, offUp, offToward, twinU, twinV]; for a tile by [layer].
// kind / twin / wall given to quad() apply to all four corners.
class Mesh {
  constructor() { this.data = []; }
  quad(a, b, c, d, kind = 0, twin = null, wall = 0) {
    for (const p of [a, b, c, a, c, d]) {
      const t = twin || [p[8] || 0, p[9] || 0];
      this.data.push(p[0], p[1], p[2], p[5] || 0, p[6] || 0, p[7] || 0, p[3], p[4], wall, t[0], t[1], kind);
    }
  }
  // A convex polygon of corners [x, y, z, texX, texY], as a fan. off: of all its corners;
  // plane: v of the plane whose depth the game's cameras give it (twin.y = the way there);
  // dim: 0 = as bright as its texels .. 1 = black.
  fan(corners, kind, off, plane = null, dim = 0) {
    for (let i = 1; i + 1 < corners.length; i++) {
      for (const p of [corners[0], corners[i], corners[i + 1]]) {
        this.data.push(p[0], p[1], p[2], off[0], off[1], off[2], p[3], p[4], 0, dim, plane === null ? 0 : plane - p[1], kind);
      }
    }
  }
  get count() { return this.data.length / STRIDE; }
}

// The part of a convex polygon of corners [x, y, z, texX, texY] whose texels lie in the
// rectangle (x, y, w, h). Position and texel are affine in each other on a flat face, so
// cutting along a texel line is cutting along a line of the face.
function clip(corners, x, y, w, h) {
  for (const [axis, limit, sign] of [[3, x, 1], [3, x + w, -1], [4, y, 1], [4, y + h, -1]]) {
    const kept = [];
    corners.forEach((p, i) => {
      const q = corners[(i + 1) % corners.length];
      const dp = (p[axis] - limit) * sign, dq = (q[axis] - limit) * sign;
      if (dp >= 0) kept.push(p);
      if (dp * dq < 0) kept.push(p.map((c, k) => c + (q[k] - c) * dp / (dp - dq)));
    });
    corners = kept;
  }
  return corners;
}

export class Renderer {
  // The canvas itself has no multisampling: in the game's views every screen pixel is exactly
  // one texel, and a blended wall edge would be a new colour. First person has its own buffers.
  // unavailable: act as if the browser had no WebGL 2 (to try out the message).
  constructor(canvas, unavailable = false) {
    const gl = unavailable ? null : canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true });
    if (!gl) {
      throw new Error('This browser gives the page no WebGL 2. It takes iOS 15 or a current Chrome, Firefox '
                      + 'or Safari, with graphics acceleration switched on.');
    }
    this.gl = gl;
    this.canvas = canvas;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.textureBytes = 0;        // estimate of what the textures take on the GPU
    this.main = compile(gl, VS, FS);
    this.tiles = compile(gl, VS, FS, '#define TILES\n');
    this.sky = compile(gl, SKY_VS, SKY_FS);
    this.presenter = compile(gl, SKY_VS, PRESENT_FS);
    this.buffers = null;          // what first person is drawn into, see target()
    this.skyBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    this.anisotropy = anisotropy && [anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
                                     Math.min(8, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT))];
    this.batches = {};
    this.textures = [];           // [target, texture, has mip levels] of everything that is filtered differently per look
    this.smooth = null;
    this.drawn = 0;
    this.calls = 0;
  }

  // ---------------------------------------------------------------- textures
  // A 2D texture from an image or from [width, height, Uint8Array of RGBA].
  texture(source, { wrap = this.gl.CLAMP_TO_EDGE, levels = 0, filtered = true } = {}) {
    const gl = this.gl, texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (Array.isArray(source)) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source[0], source[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, source[2]);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    if (levels) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    if (filtered) this.textures.push([gl.TEXTURE_2D, texture, levels > 0]);
    const [width, height] = Array.isArray(source) ? source : [source.width, source.height];
    this.textureBytes += width * height * 4 * (levels ? 4 / 3 : 1);
    return { texture, width, height, target: gl.TEXTURE_2D };
  }

  // Floor and roof tiles: every cell of the tile sheet becomes a layer of an
  // array texture, so that mip-mapping and anisotropic filtering never mix
  // neighbouring tiles. Also cuts the tile that repeats around the map.
  tileTextures(sheet, { cells, res, margin }, ground) {
    const gl = this.gl, size = res + 2 * margin;
    const source = this.texture(sheet, { filtered: false });
    const frame = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, source.texture, 0);
    const texture = gl.createTexture(), layers = Math.min(cells.length, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS));
    if (layers < cells.length) console.warn(`[fp] ${cells.length} tiles, this GPU takes ${layers}`);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.floor(Math.log2(size)) + 1, gl.RGBA8, size, size, Math.max(1, layers));
    cells.slice(0, layers).forEach(([x, y], layer) => gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, x, y, size, size));
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.push([gl.TEXTURE_2D_ARRAY, texture, true]);
    this.tileTexture = { texture, width: size, height: size, target: gl.TEXTURE_2D_ARRAY, layers };
    this.textureBytes += size * size * 4 * layers * 4 / 3 - sheet.width * sheet.height * 4;    // the sheet is given back below

    // The commonest floor tile, without its rim, repeated: what lies around the map.
    // On the map the neighbours' rims cover the few open texels at a tile's corners;
    // out here they get the tile's mean colour.
    const rgb = ground.color.map((c) => Math.round(c * 255));
    let tile = [1, 1, new Uint8Array([...rgb, 255])];
    if (ground.cell >= 0) {
      const [x, y] = cells[ground.cell], pixels = new Uint8Array(res * res * 4);
      gl.readPixels(x + margin, y + margin, res, res, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] < 255) pixels.set([...rgb, 255], i);
      tile = [res, res, pixels];
    }
    this.groundTexture = this.texture(tile, { wrap: gl.REPEAT, levels: 1000 });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(frame);
    gl.deleteTexture(source.texture);
  }

  // 64 x 64 texels of soft noise around mid grey that repeat: white noise, blurred twice.
  grain() {
    const n = 64;
    let seed = 7, cells = Float32Array.from({ length: n * n }, () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    for (let pass = 0; pass < 2; pass++) {
      cells = cells.map((_, i) => {
        let sum = 0;
        for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) sum += cells[((Math.floor(i / n) + dy + n) % n) * n + (i % n + dx + n) % n];
        return sum / 9;
      });
    }
    const spread = Math.hypot(...cells) / n, pixels = new Uint8Array(n * n * 4).fill(255);    // spread: their standard deviation
    cells.forEach((c, i) => pixels.fill(Math.max(0, Math.min(255, Math.round(127.5 + c / spread * 42))), i * 4, i * 4 + 3));
    return this.texture([n, n, pixels], { wrap: this.gl.REPEAT, levels: 1000 });
  }

  // The buffers first person is drawn into, made anew when the size changes. retro: a picture
  // of one pixel to every `block` of the canvas each way; else one of the canvas's size,
  // multisampled (`drawn`) and resolved into `picture` when it is finished. size: retro, the
  // canvas pixels to each pixel of the picture if not by the rule (view.block).
  target(retro, size = 0) {
    const gl = this.gl, old = this.buffers;
    const block = !retro ? 1 : size >= 1 ? Math.round(size) : Math.max(1, Math.round(Math.min(this.canvas.width, this.canvas.height) / RETRO_LINES));
    const width = Math.ceil(this.canvas.width / block), height = Math.ceil(this.canvas.height / block);
    if (old && old.width === width && old.height === height && old.retro === retro && old.block === block) return old;
    if (old) {
      gl.deleteTexture(old.picture);
      old.stores.forEach((store) => gl.deleteRenderbuffer(store));
      [old.drawn, old.shown].forEach((frame) => gl.deleteFramebuffer(frame));
    }
    const picture = gl.createTexture(), shown = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, picture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shown);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, picture, 0);
    const samples = retro ? 0 : Math.min(SAMPLES, gl.getParameter(gl.MAX_SAMPLES));
    const store = (format, attachment) => {         // on the framebuffer that is bound
      const buffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, buffer);
      return buffer;
    };
    const drawn = samples ? gl.createFramebuffer() : shown;
    gl.bindFramebuffer(gl.FRAMEBUFFER, drawn);
    const stores = [...(samples ? [store(gl.RGBA8, gl.COLOR_ATTACHMENT0)] : []), store(gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT)];
    this.buffers = { retro, block, width, height, picture, shown, drawn, stores };
    return this.buffers;
  }

  // The finished first-person picture onto the canvas.
  present({ block, width, height, picture, shown, drawn }) {
    const gl = this.gl, u = this.presenter.uniforms, canvas = this.canvas;
    if (drawn !== shown) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, drawn);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, shown);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.presenter.program);
    gl.bindTexture(gl.TEXTURE_2D, picture);
    gl.uniform1i(u.uScene, 0);
    // The picture may be a little larger than the canvas: what is over is cut off evenly all round.
    gl.uniform3f(u.uBlock, Math.floor((width * block - canvas.width) / 2), Math.floor((height * block - canvas.height) / 2), block);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.calls++;
  }

  // First person: mip-mapped and anisotropic (the shader keeps magnified texels crisp).
  // Otherwise nearest: one texel per screen pixel, exactly the game's.
  setSmooth(smooth) {
    if (smooth === this.smooth) return;
    this.smooth = smooth;
    const gl = this.gl;
    for (const [target, texture, mipped] of this.textures) {
      gl.bindTexture(target, texture);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, !smooth ? gl.NEAREST : mipped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
      if (this.anisotropy) gl.texParameterf(target, this.anisotropy[0], smooth ? this.anisotropy[1] : 1);
    }
  }

  upload(mesh, texture, dynamic = false) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.data), dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    return { buffer, count: mesh.count, texture };
  }

  // ------------------------------------------------------------ scene meshes
  // images: [tile sheet, light image, the rock's material if scene.rock, ...sprite pages], decoded (fp.js downloads them)
  build(scene, proj, [sheet, light, ...images]) {
    const stone = scene.rock && images.shift();
    const largest = Math.max(...[sheet, ...images].flatMap((image) => [image.width, image.height]));
    if (largest > this.maxSize) {
      throw new Error(`this map needs textures of ${largest} pixels, this device stops at ${this.maxSize}`);
    }
    this.tileTextures(sheet, scene.tiles, scene.ground);
    this.lightTexture = this.texture(light, { filtered: false });
    this.grainTexture = this.grain();
    const pages = images.map((image) => this.texture(image, { levels: MIP_LEVELS }));
    const white = this.texture([1, 1, new Uint8Array([255, 255, 255, 255])], { filtered: false });
    this.proj = proj;
    this.scene = scene;
    const sprites = scene.sprites;
    const perPage = (fill) => pages.map((page, n) => {
      const mesh = new Mesh();
      fill(mesh, n);
      return this.upload(mesh, page);
    });

    // Floors and roofs: one quad per square, slightly larger than the square
    // because tile art overhangs its rhombus; drawn in the engine's order.
    const { res, margin } = scene.tiles;
    const size = res + 2 * margin, m = margin / res;
    // grow: units added all round (the shader repeats the tile's edge there, see uClamp).
    const squares = (ids, z, wanted = () => true, grow = 0) => {
      const mesh = new Mesh(), g = m + grow, t = grow * res;
      for (let sq = 0; sq < 10000; sq++) {
        const layer = (ids[sq] || 0) - 1;
        if (layer < 0 || layer >= this.tileTexture.layers || !wanted(sq)) continue;
        const u = sq % 100, v = Math.floor(sq / 100);
        mesh.quad([u - g, v - g, z, -t, -t, layer], [u + 1 + g, v - g, z, size + t, -t, layer],
                  [u + 1 + g, v + 1 + g, z, size + t, size + t, layer], [u - g, v + 1 + g, z, -t, size + t, layer]);
      }
      return this.upload(mesh, this.tileTexture);
    };
    this.batches.floor = squares(scene.floor, 0);
    this.batches.roof = squares(scene.roof, proj.roofZ);
    // First person: not the squares that a form stands for (the slab of tiles over a tent) ...
    const formed = new Set(scene.hiddenRoof), kept = (sq) => !formed.has(sq);
    this.batches.roofFp = squares(scene.roof, proj.roofZ, kept);
    // ... and eaves, a hair above the roof tiles, which therefore hide them wherever there is a tile.
    this.batches.eaves = squares(scene.roof, proj.roofZ + 0.004, kept, EAVES);
    // ... from EAVES_INSET texels inside the square: the outermost ones follow the saw teeth of the
    // tile's pixel edge and would be drawn out into stripes.
    this.tileEdge = [margin + EAVES_INSET + 0.5, size - margin - EAVES_INSET - 0.5];
    // Underground nothing has a roof tile. First person stands the rock around the open ground
    // (tools/fp/rock.py) and lays it over it as the ceiling; without rock the floor repeats overhead.
    // Built rooms down there (scene.rock.tiled) keep the floor's tiles overhead, a hair under the rock.
    const tiled = scene.rock && Uint8Array.from(atob(scene.rock.tiled), (c) => c.charCodeAt(0));
    this.batches.ceiling = squares(scene.indoor ? scene.floor : [], proj.roofZ - (tiled ? 0.02 : 0),
                                   (sq) => !scene.roof[sq] && (!tiled || (tiled[sq >> 3] >> (sq & 7)) & 1));
    this.batches.rock = this.rock(scene.rock, stone);

    // What lies under and around the map: its commonest floor tile, square for square.
    const ground = new Mesh(), far = 400;
    ground.quad(...[[-far, -far], [far + 100, -far], [far + 100, far + 100], [-far, far + 100]]
      .map(([u, v]) => [u, v, -0.02, u * res, v * res]));
    this.batches.ground = this.upload(ground, this.groundTexture);

    // Walls. `walls` is what the game's camera sees of them (fronts and tops), `backs` what it
    // does not (first person only), `sheets` what has no thickness (signs, railings).
    // First person leaves out the walls that a solid or a form stands for (scene.hiddenWalls).
    const gone = new Set(scene.hiddenWalls.map((n) => scene.walls[n])), shown = (wall) => !gone.has(wall);
    const solid = scene.walls.filter((wall) => wall[10] > 0);
    this.slabs = solid.filter((wall) => wall[10] >= 0.1);        // thinner ones are fences: nothing hangs in them
    const fronts = (walls) => perPage((mesh, page) => walls.forEach((wall) => this.wallFront(mesh, wall, page)));
    const rests = (walls, trims) => perPage((mesh, page) => {
      walls.forEach((wall) => this.wallRest(mesh, wall, page));
      for (const [s, ua, va, ub, vb, z0, z1, tx, ty, tw, th] of trims) {
        const [p, x, y] = sprites[s];
        if (p === page) this.upright(mesh, ua, va, ub, vb, z0, z1, x + tx, y + ty, tw, th);
      }
    });
    this.batches.walls = fronts(solid.filter(shown));
    this.batches.wallsGone = fronts(solid.filter((wall) => !shown(wall)));
    this.batches.backs = rests(solid.filter(shown), scene.trims);
    this.batches.backsGone = rests(solid.filter((wall) => !shown(wall)), []);
    const sheets = (wanted) => perPage((mesh, page) => {
      scene.walls.forEach((wall) => { if (!(wall[10] > 0) && wanted(wall) && sprites[wall[0]][0] === page) this.sheet(mesh, wall); });
    });
    this.batches.sheets = sheets(() => true);
    this.batches.sheetsFp = sheets(shown);
    this.batches.forms = perPage((mesh, page) => {
      for (const row of scene.forms) if (sprites[row[0]][0] === page) this.form(mesh, row);
    });
    // Doors are sheets that come and go (see setDoors).
    this.batches.doors = pages.map((page) => this.upload(new Mesh(), page, true));
    this.setDoors(scene.doors);

    // Top view only: every wall as a coloured bar on the floor (red along u, green along v), doors blue.
    const bars = (quads, pick) => {
      const mesh = new Mesh();
      for (const [, ua, va, ub, vb] of quads) {
        const du = ub - ua, dv = vb - va, length = Math.hypot(du, dv) || 1;
        if (!pick(Math.abs(du) < Math.abs(dv) ? 1 : 0)) continue;
        const nu = -dv / length * 0.04, nv = du / length * 0.04;
        mesh.quad([ua - nu, va - nv, 0, 0, 0], [ub - nu, vb - nv, 0, 0, 0],
                  [ub + nu, vb + nv, 0, 0, 0], [ua + nu, va + nv, 0, 0, 0]);
      }
      return this.upload(mesh, white);
    };
    this.batches.wallLines = [bars(scene.walls, (axis) => axis === 0), bars(scene.walls, (axis) => axis === 1),
                              bars(scene.doors, () => true)];

    // Sprite cards (scenery, items): see card() in geom.js for how they stand.
    const hung = scene.boards.map(([, u, v]) => this.inWall(u, v));
    this.batches.boards = perPage((mesh, page) => {
      scene.boards.forEach(([s, u, v, stack], n) => { if (sprites[s][0] === page) this.board(mesh, sprites[s], u, v, stack, hung[n]); });
    });

    // First person shows a card without the shadow that was painted into its
    // sprite (scene.shadows) and lays that shadow on the floor. Cards that are
    // solids there (scene.hidden) are left out, those standing on a solid are
    // lifted onto it, and what a solid's sprite shows beside the solid stands on it.
    const unshadowed = new Map(scene.shadows.map(([board, body]) => [board, body]));
    const asSolid = new Set(scene.hidden), lifted = new Map(scene.lifts.map(([board, ...to]) => [board, to]));
    // Plants (scene.crossed) stand as two sheets across each other, not as a card that turns.
    const crossed = new Set(scene.crossed);
    const cards = (wanted) => perPage((mesh, page) => {
      scene.boards.forEach(([s, u, v, stack], n) => {
        const sprite = sprites[unshadowed.has(n) ? unshadowed.get(n) : s];
        if (sprite[0] !== page || asSolid.has(n) !== wanted) return;
        const [du, dv, z] = lifted.get(n) || [0, 0, 0];
        if (crossed.has(n)) this.cross(mesh, sprite, u, v);
        else this.board(mesh, sprite, u + du, v + dv, stack, hung[n], z);
      });
    });
    this.batches.boardsFp = cards(false);
    this.batches.plain = cards(true);         // the cards of the solids: shown instead when solids are switched off
    this.batches.rests = perPage((mesh, page) => {
      for (const [s, u, v, z, top] of scene.rests) if (sprites[s][0] === page) this.board(mesh, sprites[s], u, v, 0, 0, z, top);
    });

    // Solids: `props` is what the game's camera sees of those that stand in for one card,
    // `propsFp` everything else of them (first person only).
    const solids = (seen) => perPage((mesh, page) => {
      for (const row of scene.props) if (sprites[row[0]][0] === page) this.solid(mesh, row, seen);
    });
    this.batches.props = solids(true);
    this.batches.propsFp = solids(false);

    // Decals: FLAT sprites lie on the floor; un-project the sprite rectangle.
    const flat = (rows) => perPage((mesh, page) => {
      for (const [s, u, v] of rows) {
        const [p, x, y, w, h, ox, oy] = sprites[s];
        if (p !== page) continue;
        const corner = (i, j) => {
          const [du, dv] = proj.deltaToGround(ox + i * w, oy + j * h);
          return [u + du, v + dv, 0, x + i * w, y + j * h];
        };
        mesh.quad(corner(0, 1), corner(1, 1), corner(1, 0), corner(0, 0));
      }
    });
    const exits = new Set(scene.exits);
    this.batches.decals = flat(scene.decals.filter((row, n) => !exits.has(n)));
    this.batches.exits = flat(scene.exits.map((n) => scene.decals[n]));
    this.batches.cast = flat([...scene.shadows.map(([board, , shadow]) => [shadow, scene.boards[board][1], scene.boards[board][2]]),
                              ...scene.casts]);

    // Critters change sprite every frame: one small dynamic buffer per page.
    this.batches.critters = pages.map((page) => this.upload(new Mesh(), page, true));
    this.critterKey = '';

    // Glows of flames and lamps: cards in the hex-row plane of their object, drawn
    // additively. One small texture holds a soft disc.
    const disc = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) {
      const r = Math.hypot(i % 64 - 31.5, Math.floor(i / 64) - 31.5) / 31.5;
      disc.fill(Math.round(255 * Math.max(0, 1 - r) ** 2), i * 4, i * 4 + 3);
      disc[i * 4 + 3] = 255;
    }
    const glowTexture = this.texture([64, 64, disc]);
    const colours = [...new Set(scene.glows.map((glow) => glow.slice(4).join()))];
    this.batches.glows = colours.map((colour) => {
      const mesh = new Mesh(), r = GLOW_RADIUS;
      for (const [u, v, px, z, ...rgb] of scene.glows) {
        if (rgb.join() !== colour) continue;
        const x = px / proj.bbPx, plane = rowPlane(proj, u, v) - v;
        const corner = (i, j) => [u, v, 0, i * 64, j * 64, x + (2 * i - 1) * r, z + (1 - 2 * j) * r, 0, z + (1 - 2 * j) * r, plane];
        mesh.quad(corner(0, 1), corner(1, 1), corner(1, 0), corner(0, 0), 1);
      }
      return { ...this.upload(mesh, glowTexture), rgb: colour.split(',').map(Number) };
    });
  }

  // The rock faces of an underground map and its ceiling: [faces, ceiling] in the material that
  // repeats. A loop lists every corner at the floor, half way up and at the top; a face stands
  // between two neighbouring corners, seen from the open side (the rock is on the left of the
  // way round). Texels run with the distance along the loop and with the height.
  rock(rock, image) {
    const faces = new Mesh(), ceiling = new Mesh();
    if (!rock) return [];
    const texture = this.texture(image, { wrap: this.gl.REPEAT, levels: 1000 }), k = rock.texels, top = this.proj.roofZ;
    for (const loop of rock.loops) {
      let along = 0;
      for (let i = 0; i < loop.length; i += 6) {
        const a = loop.slice(i, i + 6), b = loop.slice((i + 6) % loop.length, (i + 6) % loop.length + 6);
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, normal = [(b[1] - a[1]) / length, (a[0] - b[0]) / length];
        const corner = (p, ring, s) => [p[2 * ring], p[2 * ring + 1], ring * top / 2, s * k, -ring * top / 2 * k];
        for (const ring of [0, 1]) {
          faces.quad(corner(a, ring, along), corner(b, ring, along + length), corner(b, ring + 1, along + length), corner(a, ring + 1, along), 2, normal);
        }
        along += length;
      }
    }
    // Seen from below.
    ceiling.quad(...[[0, 0], [0, 100], [100, 100], [100, 0]].map(([u, v]) => [u, v, top, u * k, v * k]));
    return [this.upload(faces, texture), this.upload(ceiling, texture)];
  }

  // An upright quad between ground points a and b, from height z0 to z1, showing the texels
  // (tx, ty) .. (tx + tw, ty + th). It faces whoever has a on the left (one-sided where culled).
  upright(mesh, ua, va, ub, vb, z0, z1, tx, ty, tw, th) {
    const length = Math.hypot(ub - ua, vb - va) || 1;
    mesh.quad([ua, va, z0, tx, ty + th], [ub, vb, z0, tx + tw, ty + th], [ub, vb, z1, tx + tw, ty], [ua, va, z1, tx, ty],
              2, [(vb - va) / length, (ua - ub) / length]);
  }

  sheet(mesh, [s, ua, va, ub, vb, z0, z1]) {
    const [, x, y, w, h] = this.scene.sprites[s];
    this.upright(mesh, ua, va, ub, vb, z0, z1, x, y, w, h);
  }

  // What the game's camera sees of a wall: its picture up to zc on the front plane, and the
  // rows above zc laid back. Texture rows are screen rows, hpx of them per unit of height;
  // the camera's ray through a point of the front plane at height z1 comes down to zc
  // (z1 - zc) / k.z further on, k being the unit vector towards the camera.
  wallFront(mesh, [s, ua, va, ub, vb, z0, z1, , , zc], page) {
    const [p, x, y, w, h] = this.scene.sprites[s];
    if (p !== page) return;
    const top = (z1 - zc) * this.proj.hpx;
    this.upright(mesh, ua, va, ub, vb, z0, zc, x, y + top, w, h - top);
    if (top <= 0) return;
    const k = this.proj.towardCamera(), far = (z1 - zc) / k[2], du = -k[0] * far, dv = -k[1] * far;
    const home = [-du, -dv, z1 - zc];
    mesh.quad([ua, va, zc, x, y + top], [ub, vb, zc, x + w, y + top],
              [ub + du, vb + dv, zc, x + w, y, ...home], [ua + du, va + dv, zc, x, y, ...home], 3, [0, 0]);
  }

  // What the game's camera does not see of a wall. The far side, `thick` behind the front: the
  // same outline seen from behind, in the picture `back` (-1: the wall's own). And above zc, where
  // the game drew the wall cut open: the pictures that go on from there, on the front and the back.
  wallRest(mesh, [s, ua, va, ub, vb, z0, z1, , , zc, thick, back, above = -1, aboveBack = -1], page) {
    const sprites = this.scene.sprites, hpx = this.proj.hpx;
    const [front, fx, fy, w, fh] = sprites[s], top = (z1 - zc) * hpx;
    const length = Math.hypot(ub - ua, vb - va) || 1, nu = (vb - va) / length * thick, nv = (ua - ub) / length * thick;
    const [p, x, y, , h] = back >= 0 ? sprites[back] : [front, fx, fy + top, w, fh - top];
    if (p === page) this.upright(mesh, ub - nu, vb - nv, ua - nu, va - nv, z0, zc, x + w, y, -w, h);
    if (above >= 0 && sprites[above][0] === page) {
      const [, ax, ay, , ah] = sprites[above];
      this.upright(mesh, ua, va, ub, vb, zc, zc + ah / hpx, ax, ay, w, ah);
    }
    if (aboveBack >= 0 && sprites[aboveBack][0] === page) {
      const [, ax, ay, , ah] = sprites[aboveBack];
      this.upright(mesh, ub - nu, vb - nv, ua - nu, va - nv, zc, zc + ah / hpx, ax + w, ay, -w, ah);
    }
  }

  refill(batches, fill) {
    const gl = this.gl;
    batches.forEach((batch, page) => {
      const mesh = new Mesh();
      fill(mesh, page);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.data), gl.DYNAMIC_DRAW);
      batch.count = mesh.count;
    });
  }

  // doors: the rows of scene.doors that are shut right now
  setDoors(doors) {
    this.refill(this.batches.doors, (mesh, page) => {
      for (const door of doors) if (this.scene.sprites[door[0]][0] === page) this.sheet(mesh, door);
    });
  }

  // One sprite card anchored at ground point (u, v); stack: see rowPlane() in geom.js;
  // wall: see inWall(). First person: z = the height it stands at (on a solid), top = the
  // height its upper edge is drawn out to (a stem that reaches what it carries).
  board(mesh, sprite, u, v, stack, wall = 0, z = 0, top = 0) {
    const [, x, y, w, h, ox] = sprite;
    const c = card(this.proj, sprite);
    const [du, dv] = top ? [0, 0] : this.proj.deltaToGround(0, c.shift);
    const row = rowPlane(this.proj, u, v, stack);
    const corner = (i, j) => [u + du, v + dv, 0, x + i * w, y + j * h,
                              (ox + i * w) / this.proj.bbPx, j ? c.z0 : c.z1, j ? c.lean : -c.lean,
                              j ? z + c.up0 : top || z + c.up1, row - (v + dv)];
    mesh.quad(corner(0, 1), corner(1, 1), corner(1, 0), corner(0, 0), 1, null, wall);
  }

  // A plant anchored at ground point (u, v): its sprite on two upright sheets through
  // the point it stands on, one facing the game's camera and one across that.
  cross(mesh, sprite, u, v) {
    const [, x, y, w, h, ox] = sprite, proj = this.proj, c = card(proj, sprite);
    const [du, dv] = proj.deltaToGround(0, c.shift), at = [u + du, v + dv, 0];
    for (const [ru, rv] of [proj.groundDir(1, 0), proj.groundDir(0, 1)]) {
      const corner = (i, j) => {
        const along = (ox + i * w) / proj.bbPx;
        return [...at, x + i * w, y + j * h, ru * along, rv * along, j ? c.up0 : c.up1];
      };
      mesh.quad(corner(0, 1), corner(1, 1), corner(1, 0), corner(0, 0), 5);
    }
  }

  // The faces of one solid (a row of scene.props, see tools/fp/scene.py). seen: those that the
  // game's camera sees of a solid that stands in for one card; else all the others.
  solid(mesh, [s, u, v, board, round, cu, cv, a, b, z0, z1, wallU, wallV], seen) {
    const proj = this.proj, [, x, y, w, h, ox, oy] = this.scene.sprites[s];
    const [ax, ay] = proj.groundToPx(u, v);
    // The texel that a point shows: the pixel it lands on in the sprite, whose anchor is (u, v).
    const texelAt = ([pu, pv, pz]) => {
      const [px, py] = proj.groundToPx(pu, pv, pz);
      return [x + px - ax - ox, y + py - ay - oy];
    };
    let plane = null;
    if (board >= 0) {
      const [, bu, bv, stack] = this.scene.boards[board];
      plane = rowPlane(proj, bu, bv, stack) + OVER_CARD;
    }
    // A face shows what its points show, or (a far side) what their mirror images `from` show.
    const face = (points, normal, visible, from = points) => {
      if ((visible && board >= 0) !== seen) return;
      const corners = clip(points.map((point, i) => [...point, ...texelAt(from[i])]), x, y, w, h);
      if (corners.length >= 3) mesh.fan(corners, 4, normal, visible && seen ? plane : null);
    };
    if (round) {
      // The cylinder over the floor ellipse that is a x b px on the game's screen: corner 0 is
      // screen right, a quarter turn on is towards the camera. Towards its outline the sprite
      // shows the drum at a grazing angle: a few ragged columns of texels for a quarter of the way
      // round. So only the quarter that faces the camera shows what it lands on (the middle 0.7
      // of the sprite's width), and the three other quarters repeat it, mirrored at every seam.
      const quarter = DRUM_SIDES / 4;
      const rim = (i, z) => {
        const angle = 2 * Math.PI * i / DRUM_SIDES;
        const [du, dv] = proj.deltaToGround(a * Math.cos(angle), b * Math.sin(angle));
        return [cu + du, cv + dv, z];
      };
      const side = (i, j) => [rim(i, z0), rim(j, z0), rim(j, z1), rim(i, z1)];
      for (let i = 0; i < DRUM_SIDES; i++) {
        const step = (i + DRUM_SIDES - quarter / 2) % DRUM_SIDES;           // from where the facing quarter begins
        const turn = Math.floor(step / quarter), within = step % quarter;
        const from = (n) => quarter / 2 + (turn % 2 ? quarter - n : n);
        const out = rim(i + 0.5, 0), length = Math.hypot(out[0] - cu, out[1] - cv) || 1;
        face(side(i, i + 1), [(out[0] - cu) / length, (out[1] - cv) / length, 0], turn === 0, side(from(within), from(within + 1)));
      }
      face(Array.from({ length: DRUM_SIDES }, (_, i) => rim(i, z1)), [0, 0, 1], true);
      return;
    }
    const u0 = cu - a / 2, u1 = cu + a / 2, v0 = cv - b / 2, v1 = cv + b / 2;
    const alongU = (v, low, high) => [[u0, v, low], [u1, v, low], [u1, v, high], [u0, v, high]];
    const alongV = (u, low, high) => [[u, v0, low], [u, v1, low], [u, v1, high], [u, v0, high]];
    face([[u0, v0, z1], [u1, v0, z1], [u1, v1, z1], [u0, v1, z1]], [0, 0, 1], true);
    face(alongU(v1, z0, z1), [0, 1, 0], true);
    face(alongV(u1, z0, z1), [1, 0, 0], true);
    face(alongU(v0, z0, z1), [0, -1, 0], false, alongU(v1, z0, z1));
    face(alongV(u0, z0, z1), [-1, 0, 0], false, alongV(u1, z0, z1));
    // What rises behind the top: on the far sides, seen from the inside.
    if (wallU > z1) face(alongU(v0, z1, wallU), [0, 1, 0], true);
    if (wallV > z1) face(alongV(u0, z1, wallV), [1, 0, 0], true);
  }

  // One form (a row of scene.forms): faces [dim, normal, points, from] in the picture `s`, whose
  // anchor is ground point (u, v). points = x, y, z of each corner; from = the points whose
  // pixels the corners show instead of their own (0: their own).
  form(mesh, [s, u, v, faces]) {
    const proj = this.proj, [, x, y, w, h, ox, oy] = this.scene.sprites[s];
    const [ax, ay] = proj.groundToPx(u, v);
    for (const [dim, normal, points, from] of faces) {
      const corners = [], shows = from || points;
      for (let i = 0; i < points.length; i += 3) {
        const [px, py] = proj.groundToPx(shows[i], shows[i + 1], shows[i + 2]);
        corners.push([points[i], points[i + 1], points[i + 2], x + px - ax - ox, y + py - ay - oy]);
      }
      const inside = clip(corners, x, y, w, h);
      if (inside.length >= 3) mesh.fan(inside, 4, normal, null, dim);
    }
  }

  // The thickness (and a skin) of the wall that a ground point lies in, else 0.
  inWall(u, v) {
    for (const [, ua, va, ub, vb, , , , , , thick] of this.slabs) {
      const along = va === vb;        // the slab lies behind the front plane, towards -v or -u
      if (u >= Math.min(ua, ub) - (along ? 0 : thick) && u <= Math.max(ua, ub)
          && v >= Math.min(va, vb) - (along ? thick : 0) && v <= Math.max(va, vb)) return thick + CARD_SKIN;
    }
    return 0;
  }

  // critters: [{sprite, u, v, stack}] with sprite = the row of scene.sprites to show now.
  // key: any value that changes whenever the list does (the buffers are only rebuilt then).
  setCritters(list, key) {
    if (key === this.critterKey) return;
    this.critterKey = key;
    this.refill(this.batches.critters, (mesh, page) => {
      for (const c of list) if (c.sprite[0] === page) this.board(mesh, c.sprite, c.u, c.v, c.stack);
    });
  }

  // ------------------------------------------------------------------ drawing
  use(program, view) {
    const gl = this.gl, u = program.uniforms, mood = view.mood;
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(u.uViewProj, false, view.matrix);
    gl.uniform3fv(u.uRight, view.right);
    gl.uniform3fv(u.uUp, view.up);
    gl.uniform3fv(u.uToward, view.toward);
    gl.uniform3fv(u.uEye, view.eye);
    gl.uniform3fv(u.uCardNormal, view.cardNormal);
    gl.uniform4fv(u.uRay, view.ray);
    gl.uniform2fv(u.uSunAt, view.sunAt);
    gl.uniform1f(u.uFp, view.mode === 'fp' ? 1 : 0);
    gl.uniform3fv(u.uSky, mood.sky);
    gl.uniform3fv(u.uShade, mood.shade);
    gl.uniform3fv(u.uLamp, mood.lamp);
    gl.uniform4f(u.uFog, ...mood.horizon, mood.fog);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1i(u.uLight, 1);
    gl.uniform1i(u.uGrain, 2);
    gl.uniform1f(u.uGrainBy, view.mode === 'fp' && !view.retro ? GRAIN : 0);
    gl.uniform1f(u.uColour, mood.colour ?? 1);
    gl.uniform1f(u.uRetro, view.retro ? 1 : 0);
    gl.uniform1f(u.uWallTop, this.proj.roofZ);
    this.program = program;
  }

  drawBatch(batch, { tint = 1, flat = null, cut = 0.5, floor = 0, glow = 0, clamp = [-1e6, 1e6] } = {}) {
    if (!batch.count) return;
    const gl = this.gl, u = this.program.uniforms;
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
    ATTRIBUTES.forEach(([size, offset], location) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE * 4, offset);
    });
    gl.bindTexture(batch.texture.target, batch.texture.texture);
    gl.uniform2f(u.uTexel, 1 / batch.texture.width, 1 / batch.texture.height);
    gl.uniform3fv(u.uTint, typeof tint === 'number' ? [tint, tint, tint] : tint);
    gl.uniform4fv(u.uFlat, flat || [0, 0, 0, 0]);
    gl.uniform1f(u.uCut, cut);
    gl.uniform1f(u.uFloor, floor);
    gl.uniform1f(u.uGlow, glow);
    gl.uniform2fv(u.uClamp, clamp);
    gl.drawArrays(gl.TRIANGLES, 0, batch.count);
    this.drawn += batch.count / 6;
    this.calls++;
  }

  drawSky(view) {
    const gl = this.gl, u = this.sky.uniforms, mood = view.mood;
    gl.useProgram(this.sky.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform3fv(u.uCamRight, view.right.map((c) => c * view.tan[0]));
    gl.uniform3fv(u.uCamUp, view.cameraUp.map((c) => c * view.tan[1]));
    gl.uniform3fv(u.uCamForward, view.skyForward || view.forward);       // skyForward: the picture is slid up (fp.js, lift)
    gl.uniform3fv(u.uZenith, mood.zenith);
    gl.uniform3fv(u.uHorizon, mood.horizon);
    gl.uniform3fv(u.uSunDir, view.sunDir);
    gl.uniform3fv(u.uSunColour, mood.sunColour);
    gl.uniform3fv(u.uMesa, mood.mesa || [-1, 0, 0]);
    gl.uniform1f(u.uStars, mood.stars);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.calls++;
  }

  // view: {mode: 'fp' | 'iso' | 'top', matrix, right, up, toward, eye, cardNormal, ray, roofs, solids, proxies, mood,
  //        sunAt, and for 'fp': forward, skyForward, cameraUp, tan: [x, y], sunDir, retro, block}
  draw(view) {
    const gl = this.gl, b = this.batches;
    const fp = view.mode === 'fp', target = fp ? this.target(view.retro, view.block) : null;
    const [width, height] = target ? [target.width, target.height] : [this.canvas.width, this.canvas.height];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target && target.drawn);
    // Holes: half-transparent is the game's own rule; mip-mapped alpha thins out, so first person cuts lower.
    const sprite = { cut: fp ? 0.4 : 0.5 }, tile = { cut: fp ? 0.25 : 0.5 };
    this.drawn = this.calls = 0;
    this.setSmooth(fp);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lightTexture.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.grainTexture.texture);
    gl.activeTexture(gl.TEXTURE0);

    // Nothing lies below the floor, so floor and decals are painted first without
    // depth, in the engine's own order (later tiles overdraw their neighbours' rim).
    if (fp) {
      this.drawSky(view);
      this.use(this.main, view);
      this.drawBatch(b.ground, { cut: 0 });
    }
    this.use(this.tiles, view);
    this.drawBatch(b.floor, { ...tile, floor: 1 });
    this.use(this.main, view);
    b.decals.forEach((batch) => this.drawBatch(batch, { ...sprite, floor: 1 }));
    if (fp) {
      // Thin layers on the floor: the painted shadows of sprites, and the exit grid, whose
      // hatching would be a solid carpet from eye height.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      gl.blendColor(0, 0, 0, CAST_SHADOW);
      b.cast.forEach((batch) => this.drawBatch(batch, sprite));
      gl.blendColor(0, 0, 0, EXIT_GRID);
      b.exits.forEach((batch) => this.drawBatch(batch, { cut: 0.15, floor: 1 }));
      gl.disable(gl.BLEND);
    } else {
      b.exits.forEach((batch) => this.drawBatch(batch, sprite));
    }

    if (view.mode === 'top') {
      // Straight down nothing hides anything: paint walls as bars, sprites lying flat.
      this.drawBatch(b.wallLines[0], { flat: [1, 0.25, 0.2, 1] });
      this.drawBatch(b.wallLines[1], { flat: [0.3, 1, 0.3, 1] });
      this.drawBatch(b.wallLines[2], { flat: [0.35, 0.6, 1, 1] });
      b.boards.forEach((batch) => this.drawBatch(batch));
      b.critters.forEach((batch) => this.drawBatch(batch));
      if (view.roofs) {
        this.use(this.tiles, view);
        this.drawBatch(b.roof);
      }
      return;
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    // Slabs of wall and forms: each face is seen from outside only. `stood` = what stands in for
    // walls and cards is drawn, not they: first person unless solids are switched off, and the
    // game's camera when asked (proxies=1: it must then still see the game's picture).
    const stood = fp ? view.solids : view.proxies;
    gl.enable(gl.CULL_FACE);
    for (const batches of [b.walls, ...(stood ? [b.forms] : [b.wallsGone]), ...(fp ? [b.backs] : []), ...(fp && !stood ? [b.backsGone] : [])]) {
      batches.forEach((batch) => this.drawBatch(batch, sprite));
    }
    if (fp && view.roofs) b.rock.forEach((batch, n) => this.drawBatch(batch, { cut: 0, tint: n ? 0.6 : 1 }));
    gl.disable(gl.CULL_FACE);
    // Solids after the cards: for the game's camera each lies on its own card and wins the tie.
    const solid = view.solids ? [b.sheetsFp, b.rests, b.props, b.propsFp] : [b.sheets, b.plain];
    for (const batches of fp ? [b.doors, b.boardsFp, b.critters, ...solid]
                             : [stood ? b.sheetsFp : b.sheets, b.doors, b.boards, b.critters, b.props]) {
      batches.forEach((batch) => this.drawBatch(batch, sprite));
    }
    if (view.roofs) {
      // The game paints roofs over everything; seen from inside they are ceilings.
      if (!fp) gl.disable(gl.DEPTH_TEST);
      this.use(this.tiles, view);
      if (fp) this.drawBatch(b.eaves, { ...tile, tint: CEILING, clamp: this.tileEdge });
      this.drawBatch(stood ? b.roofFp : b.roof, { ...tile, tint: fp ? CEILING : 1 });
      if (fp) this.drawBatch(b.ceiling, { ...tile, tint: CEILING * 0.85 });
    }
    if (fp && b.glows.length) {
      this.use(this.main, view);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);        // same depth plane as the card of its object: win the tie
      gl.polygonOffset(-2, -2);
      for (const batch of b.glows) this.drawBatch(batch, { glow: 1, cut: 0, tint: batch.rgb.map((c) => c * view.mood.glow * view.flicker) });
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    if (target) this.present(target);
  }
}
