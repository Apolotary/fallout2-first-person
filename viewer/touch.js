// Touch controls: two thumbs on the canvas, each followed by its own touch
// identifier, so walking and looking never disturb each other.
//
//   left half   a floating stick. It appears where the thumb lands and reads
//               the thumb's offset from there: analogue, full speed at
//               STICK_RADIUS. Pushed further, the stick's centre trails the
//               thumb, so turning back never has to cross a long dead stretch.
//   right half  dragging looks around (onLook gets the movement in CSS pixels).
//   anywhere    a short touch that stays put is a tap (onTap gets its position).
//
// Buttons are separate elements above the canvas (press()): their touches
// never arrive here.

const STICK_RADIUS = 52;      // CSS pixels of thumb travel for full speed
const DEAD_ZONE = 0.14;       // share of the radius in which a resting thumb moves nothing
const TAP_MS = 300, TAP_PX = 10;

// Keeps the browser from scrolling, zooming or making a click out of a touch. (A browser
// that is busy with a gesture of its own sends touches that cannot be cancelled.)
const cancel = (e) => { if (e.cancelable) e.preventDefault(); };

// Returns {axes: [right, forward]}, each -1..1, to be read every frame.
export function touchControls(canvas, ring, knob, onLook, onTap) {
  const axes = [0, 0];
  let stick = null, look = null;      // the touch that plays each part: {id, x, y, x0, y0, t}
  const mine = (e, part) => part && [...e.changedTouches].find((t) => t.identifier === part.id);

  function showStick() {
    ring.hidden = !stick;
    axes[0] = axes[1] = 0;
    if (!stick) return;
    let dx = stick.x - stick.x0, dy = stick.y - stick.y0;
    const reach = Math.hypot(dx, dy);
    if (reach > STICK_RADIUS) {       // the centre trails a thumb that went past the rim
      const k = STICK_RADIUS / reach;
      stick.x0 += dx * (1 - k); stick.y0 += dy * (1 - k);
      dx *= k; dy *= k;
    }
    const deflection = Math.hypot(dx, dy) / STICK_RADIUS;                     // 0..1
    const push = Math.max(0, (deflection - DEAD_ZONE) / (1 - DEAD_ZONE));     // 0..1 beyond the dead zone
    if (deflection > 0) {
      axes[0] = dx / STICK_RADIUS / deflection * push;
      axes[1] = -dy / STICK_RADIUS / deflection * push;
    }
    ring.style.transform = `translate(${stick.x0}px, ${stick.y0}px)`;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  canvas.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      const part = { id: t.identifier, x: t.clientX, y: t.clientY, x0: t.clientX, y0: t.clientY, t: e.timeStamp };
      if (t.clientX < innerWidth / 2) stick = stick || part;
      else look = look || part;
    }
    showStick();
    cancel(e);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    const s = mine(e, stick), l = mine(e, look);
    if (s) { stick.x = s.clientX; stick.y = s.clientY; showStick(); }
    if (l) {
      onLook(l.clientX - look.x, l.clientY - look.y);
      look.x = l.clientX; look.y = l.clientY;
    }
    cancel(e);
  }, { passive: false });

  const end = (e) => {
    for (const part of [stick, look]) {
      const t = mine(e, part);
      if (!t) continue;
      // (x0, y0) of the stick may have trailed the thumb; then it was no tap anyway.
      if (e.type === 'touchend' && e.timeStamp - part.t < TAP_MS
          && Math.hypot(t.clientX - part.x0, t.clientY - part.y0) < TAP_PX) onTap(t.clientX, t.clientY);
      if (part === stick) stick = null; else look = null;
    }
    showStick();
    cancel(e);
  };
  canvas.addEventListener('touchend', end, { passive: false });
  canvas.addEventListener('touchcancel', end, { passive: false });
  // A touch that ends while the page is in the background is never reported.
  document.addEventListener('visibilitychange', () => { stick = look = null; showStick(); });

  return { axes };
}

// A button that works while other fingers are down. Browsers make a click only
// out of a lone finger's tap, so with a thumb on the stick a button would stay
// dead: it acts on its own touchend instead (still a user gesture, which
// fullscreen needs); preventDefault keeps the click from arriving as well.
// Links inside the element are left alone.
export function press(button, action) {
  const mine = (e) => !e.target.closest('a');
  const act = () => { button.blur(); action(); };
  let touched = -1e9;         // when a touch last acted: a click that follows it all the same is that very press
  button.addEventListener('touchstart', (e) => {
    if (mine(e)) { cancel(e); button.classList.add('down'); }
  }, { passive: false });
  button.addEventListener('touchend', (e) => {
    if (mine(e)) { cancel(e); button.classList.remove('down'); touched = e.timeStamp; act(); }
  }, { passive: false });
  button.addEventListener('touchcancel', () => button.classList.remove('down'));
  button.addEventListener('click', (e) => mine(e) && e.timeStamp - touched > 700 && act());
}
