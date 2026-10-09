// The game's interface bar along the bottom of the first-person picture, drawn from its own
// art (hud/, written once by tools/fp/hud.py from the unpacked game):
//
//   display monitor   what the viewer says (the exported inspection text), printed the way the game prints
//                     it (display_monitor.cc): font 101 in the monitor's green, a knob in
//                     front of every message, wrapped at spaces, the newest line at the
//                     bottom, six lines, every line one pixel further right than the one above
//   item plate        the place and the light there, in the stamped capitals the art uses for
//                     SINGLE and BURST. Nothing is in hand, so the plate is the blank one.
//   counters, lights  dark: there are no hit points, armor class or action points to count.
//
// It is a picture only. Nothing on it can be pressed and touches fall through to the 3D view
// (fp.css: .hud). The bar keeps its own pixels: a whole number of screen pixels to each.

const SHARE = 0.3;            // of the page's height the bar may take at most
const KNOB = '\x95';
const INK = ['rgba(14, 9, 4, 0.9)', 'rgba(255, 236, 200, 0.26)'];     // stamped letters: the cut and its lit lower edge
const PLATE_INSET = 9;        // bar pixels between the plate's rim and its text
const TITLE_LEADING = 17;     // rows from one line of the place name to the next

// Characters the game's fonts hold as code page 1252; the rest become their plain look-alikes.
const PLAIN = { '•': KNOB, '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };

export class Iface {
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = false;         // load() found the art
    this.lines = [];            // of the monitor as wrapped, oldest first
    this.plate = ['', ''];      // place, light
    this.stale = true;          // draw() has something new to draw
  }

  // false: no art (tools/fp/hud.py was not run); the page then does without the bar.
  async load() {
    try {
      const response = await fetch('hud/hud.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const layout = await response.json();
      const image = (name) => new Promise((resolve, reject) => {
        const picture = new Image();
        picture.onload = () => resolve(picture);
        picture.onerror = () => reject(new Error(`hud/${name}.png does not load`));
        picture.src = `hud/${name}.png`;
      });
      const names = Object.keys(layout.fonts);
      const [bar, ...sheets] = await Promise.all(['iface', ...names].map(image));
      this.layout = layout;
      this.bar = bar;
      this.fonts = {};
      names.forEach((name, i) => { this.fonts[name] = { ...layout.fonts[name], sheet: sheets[i], inks: new Map() }; });
      this.capacity = Math.floor(layout.monitor[3] / this.fonts.font1.line);
      this.green = `rgb(${layout.monitorColour.join()})`;
      [this.canvas.width, this.canvas.height] = layout.size;
      this.context = this.canvas.getContext('2d');
      this.ready = true;
    } catch (error) {
      console.info(`[fp] no interface bar: ${error.message}`);
    }
    return this.ready;
  }

  // Where the bar goes on a page of width x height CSS pixels, dpr screen pixels each:
  // {scale: screen pixels per bar pixel, width, height, left, side} in CSS pixels; side = what is free beside it.
  place(width, height, dpr) {
    const [w, h] = this.layout.size;
    const scale = Math.max(1, Math.min(Math.floor(width * dpr / w), Math.floor(SHARE * height * dpr / h)));
    const left = Math.round((width * dpr - w * scale) / 2) / dpr;
    Object.assign(this.canvas.style, { width: `${w * scale / dpr}px`, height: `${h * scale / dpr}px`, left: `${left}px` });
    return { scale, width: w * scale / dpr, height: h * scale / dpr, left, side: Math.max(0, left) };
  }

  // -------------------------------------------------------------------- text
  // Glyph codes of a string.
  codes(font, text) {
    const codes = [];
    for (const char of text) {
      for (const c of PLAIN[char] || char) {
        const code = c.charCodeAt(0);
        codes.push(code === 32 || font.glyphs[code] ? code : 63);
      }
    }
    return codes;
  }

  // As the game measures: every character its width and the letter gap, a space the word gap.
  width(font, text) {
    return this.codes(font, text).reduce((sum, code) => sum + (code === 32 ? font.space : font.glyphs[code][1]) + font.letter, 0);
  }

  // The font's glyphs in one colour: white ones, their alpha the game's intensity, filled.
  ink(font, colour) {
    if (!font.inks.has(colour)) {
      const sheet = document.createElement('canvas');
      sheet.width = font.sheet.width;
      sheet.height = font.sheet.height;
      const g = sheet.getContext('2d');
      g.drawImage(font.sheet, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = colour;
      g.fillRect(0, 0, sheet.width, sheet.height);
      font.inks.set(colour, sheet);
    }
    return font.inks.get(colour);
  }

  text(font, text, x, y, colour) {
    const sheet = this.ink(font, colour);
    for (const code of this.codes(font, text)) {
      if (code !== 32) {
        const [from, w] = font.glyphs[code];
        this.context.drawImage(sheet, from, 0, w, font.height, x, y, w, font.height);
      }
      x += (code === 32 ? font.space : font.glyphs[code][1]) + font.letter;
    }
  }

  // A message as the monitor's lines: broken at the last space that still fits; the first
  // line gives up the width of its knob, and every line the pixel by which the rows step.
  wrap(message) {
    const font = this.fonts.font1, lines = [];
    let rest = message.trim().replace(/\s+/g, ' '), knob = KNOB;
    while (rest) {
      const room = this.layout.monitor[2] - this.capacity - this.width(font, knob);
      let cut = rest.length;
      while (this.width(font, rest.slice(0, cut)) >= room) {
        const space = rest.lastIndexOf(' ', cut - 1);
        if (space <= 0) break;                    // one word wider than the monitor: its edge cuts it
        cut = space;
      }
      lines.push(knob + rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
      knob = '';
    }
    return lines;
  }

  // ---------------------------------------------------------------- content
  say(message) {
    if (!this.ready) return;
    this.lines.push(...this.wrap(message));
    this.lines.splice(0, this.lines.length - this.capacity);
    this.stale = true;
  }

  // The monitor holds exactly these messages (the last lines of them).
  show(messages) {
    if (!this.ready) return;
    const key = messages.join('\n');
    if (key === this.shown) return;
    this.shown = key;
    this.lines = messages.flatMap((message) => this.wrap(message)).slice(-this.capacity);
    this.stale = true;
  }

  // What the item plate says: the place and, smaller, the light.
  label(place, light) {
    if (place === this.plate[0] && light === this.plate[1]) return;
    this.plate = [place, light];
    this.stale = true;
  }

  // The place name on as few lines as the plate's width allows, broken after a colon first.
  titleLines(text, room) {
    const font = this.fonts.font3, lines = [];
    for (const part of text.replace(/:\s+/g, ':\n').split('\n')) {
      let line = '';
      for (const word of part.split(/\s+/)) {
        if (line && this.width(font, `${line} ${word}`) > room) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
      }
      if (line) lines.push(line);
    }
    const whole = lines.join(' ');
    return this.width(font, whole) <= room ? [whole] : lines.slice(0, 2);
  }

  draw() {
    if (!this.ready || !this.stale) return;
    this.stale = false;
    const g = this.context, { monitor, plate } = this.layout, small = this.fonts.font1, big = this.fonts.font3;
    g.imageSmoothingEnabled = false;
    g.globalCompositeOperation = 'source-over';
    g.drawImage(this.bar, 0, 0);

    g.save();
    g.beginPath();
    g.rect(...monitor);
    g.clip();
    const first = this.capacity - this.lines.length;
    this.lines.forEach((line, i) => this.text(small, line, monitor[0] + first + i, monitor[1] + (first + i) * small.line, this.green));
    g.restore();

    const [place, light] = this.plate, room = plate[2] - 2 * PLATE_INSET;
    const title = place ? this.titleLines(place.toUpperCase(), room) : [];
    const height = title.length * TITLE_LEADING + (light ? small.line + 3 : 0);
    let y = plate[1] + Math.round((plate[3] - height) / 2);
    const stamp = (font, line) => {
      const x = plate[0] + Math.round((plate[2] - this.width(font, line)) / 2);
      this.text(font, line, x, y + 1, INK[1]);
      this.text(font, line, x, y, INK[0]);
    };
    g.save();
    g.beginPath();
    g.rect(plate[0] + 4, plate[1] + 4, plate[2] - 8, plate[3] - 8);
    g.clip();
    for (const line of title) { stamp(big, line); y += TITLE_LEADING; }
    if (light) { y += 3; stamp(small, light.toUpperCase()); }
    g.restore();
  }
}
