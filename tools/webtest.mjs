#!/usr/bin/env node
// Headless-Chrome test driver for the browser builds (no npm dependencies;
// speaks the Chrome DevTools Protocol over Node's built-in WebSocket).
//
//   node tools/webtest.mjs [--mobile] [--size WxH] [--headed] [--log out.log]
//                          [--timeout ms] [--cmd-timeout ms]
//                          [--debugger] [--follow] script.txt
//
// Flags:
//   --debugger   enable the Debugger domain when the page is created, so the
//                `stack` command can still pause a page that is frozen in a
//                busy loop (Debugger.enable cannot be answered by a frozen
//                page). `stack` then leaves the debugger enabled. The wasm
//                engine may run somewhat slower while it is on.
//   --follow     after the script file's last line, keep reading lines that
//                are appended to the file (e.g. `echo "tap 10 20" >> s.txt`)
//                and run them as they arrive, until a line `end` is read.
//                A line is run once its newline has been written (an
//                unterminated last line is run after the file has stayed
//                unchanged for 1 s). Commands run one at a time, in order.
//                To learn that a step finished, append a `log <text>` line
//                after it and watch the log for `-- <text>`. If the file
//                shrinks it is re-read from its first line. Use --timeout to
//                bound a forgotten session.
//
// Script: one command per line, '#' starts a comment.
//   goto <url>                  navigate and wait for load
//   wait <ms>
//   waitlog <regex> [timeoutMs] wait for a console line matching regex (default 60000)
//   waiteval <timeoutMs> <js>   poll a JS expression until truthy
//   eval <js>                   evaluate and print the result
//   shot <file.png>             viewport screenshot
//   tap <x> <y>                 touch tap (CSS px)
//   tap2 <x> <y>                two-finger tap centred on x,y
//   tapn <n> <x> <y>            n-finger tap (n = 1..5), fingers 60 px apart in
//                               a row centred on x,y (tapn 2 == tap2)
//   swipe <x1> <y1> <x2> <y2> [ms]
//   swipe2 <x1> <y1> <x2> <y2> [ms]   same with two fingers
//   hold <x1> <y1> <x2> <y2> [holdMs=650] [moveMs=400]
//                               long-press drag with one finger: touch down at
//                               x1,y1, wait holdMs, move to x2,y2 over moveMs,
//                               pause 150 ms there (so the engine sees the
//                               cursor arrive), then release. For carrying
//                               inventory items and the hold-for-action-menu
//                               slide. With x2,y2 == x1,y1 it is a plain
//                               long press; moveMs 0 jumps straight to x2,y2.
//   click <x> <y> | rclick <x> <y> | move <x> <y>
//   key <Key> | text <string>
//   stack [depth]               pause the page and print its JS/wasm call stack
//   catch                       log the stack of every thrown exception
//   fresh                       replace the page with a brand-new tab in the
//                               same browser (same profile, so IndexedDB and
//                               other site storage survive): opens a new page
//                               target, re-applies the viewport / touch / user
//                               agent emulation and the debugger / catch
//                               state, then closes the old target. Use it
//                               instead of `goto`-reloading a page after
//                               two-finger gestures, which can leave the tab
//                               delivering taps as mouse events only. The
//                               new tab is about:blank: follow with `goto`.
//                               Clears the console history that `waitlog`
//                               searches, so a later `waitlog` only matches
//                               lines from the new page.
//   log <text>
//   end                         stop reading the script here (needed to finish
//                               a --follow session; elsewhere optional)
// A leading '!' fires a command without waiting for it to finish.
// Exit code is non-zero if a wait times out or the page throws at load.

import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--size', '--log', '--chrome', '--timeout', '--cmd-timeout'].includes(args[i - 1]));
const scriptPath = positional[0];
if (flag('help') || !scriptPath) {
  console.error('usage: webtest.mjs [--mobile] [--size WxH] [--headed] [--log file] [--chrome executable] [--debugger] [--follow] script.txt');
  process.exit(flag('help') ? 0 : 2);
}

const MOBILE = flag('mobile');
const DEBUGGER = flag('debugger');
const FOLLOW = flag('follow');
const [W, H] = (opt('size', MOBILE ? '844x390' : '1280x800')).split('x').map(Number);
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
      const candidate = path.join(directory, process.platform === 'win32' ? name + '.exe' : name);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}
const CHROME = opt('chrome', findChrome());
if (!CHROME) {
  console.error('Set CHROME or use --chrome to select your Chrome executable.');
  process.exit(2);
}
const LOGFILE = opt('log', null);
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s]`;
const out = (line) => {
  console.log(line);
  if (LOGFILE) appendFileSync(LOGFILE, line + '\n');
};
if (LOGFILE) writeFileSync(LOGFILE, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(path.join(tmpdir(), 'webtest-'));

const chrome = spawn(CHROME, [
  ...(flag('headed') ? [] : ['--headless=new']),
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-swiftshader',
  // A headless page counts as a background tab: without these Chrome clamps
  // timers to 1 Hz whenever the page is silent, which stalls the game loop.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=IntensiveWakeUpThrottling',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let exitCode = 0;
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('Chrome did not report a DevTools endpoint')), 20000);
  chrome.stderr.on('data', (d) => {
    buf += d.toString();
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  chrome.on('error', (error) => { clearTimeout(timer); reject(error); });
  chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early (code ${code}): ${buf.slice(-400)}`)); });
});

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
});

let nextId = 1;
const pending = new Map();
const consoleLines = [];
const listeners = new Set();

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
    return;
  }
  if (msg.sessionId && sessionId && msg.sessionId !== sessionId) return; // a closed tab (see `fresh`)
  let line = null;
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(' ');
    line = `console.${msg.params.type}: ${text}`;
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    line = `EXCEPTION: ${d.exception?.description ?? d.text} @ ${d.url ?? ''}:${d.lineNumber ?? ''}`;
  } else if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    line = `log.${e.level}: ${e.text}${e.url ? ' @ ' + e.url : ''}`;
  } else if (msg.method === 'Network.loadingFailed' && !msg.params.canceled) {
    line = `NETFAIL: ${msg.params.errorText} (${msg.params.type})`;
  }
  if (line) {
    consoleLines.push(line);
    out(`${stamp()} ${line}`);
    for (const fn of listeners) fn(line);
  }
});

let sessionId;
// A page stuck in a busy loop never answers; fail the command instead of hanging.
const COMMAND_TIMEOUT = Number(opt('cmd-timeout', 20000));
const send = (method, params = {}, useSession = true) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`PAGE UNRESPONSIVE: ${method} got no reply in ${COMMAND_TIMEOUT}ms`));
    }, COMMAND_TIMEOUT);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    ws.send(JSON.stringify({ id, method, params, ...(useSession && sessionId ? { sessionId } : {}) }));
  });

const GLOBAL_TIMEOUT = Number(opt('timeout', 0));
if (GLOBAL_TIMEOUT > 0) {
  setTimeout(() => {
    out(`${stamp()} GLOBAL TIMEOUT after ${GLOBAL_TIMEOUT}ms`);
    process.exit(4);
  }, GLOBAL_TIMEOUT).unref();
}

// Everything that is per page target: domains, emulation, debugger state.
// `fresh` runs it again for the replacement page.
let debuggerOn = false; // Debugger domain currently enabled on the page
let catchOn = false; // `catch` is active (pause on every exception)
async function setupPage() {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: MOBILE ? 3 : 1,
    mobile: MOBILE,
    screenOrientation: MOBILE ? { type: W > H ? 'landscapePrimary' : 'portraitPrimary', angle: W > H ? 90 : 0 } : undefined,
  });
  if (MOBILE) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
  }
  if (DEBUGGER || catchOn) {
    await send('Debugger.enable');
    debuggerOn = true;
  }
  if (catchOn) await send('Debugger.setPauseOnExceptions', { state: 'all' });
}

const { targetInfos } = await send('Target.getTargets', {}, false);
let page = targetInfos.find((t) => t.type === 'page');
({ sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false));
await setupPage();

const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points });
const mouse = (type, x, y, button = 'none', buttons = 0) =>
  send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function run(line) {
  const sp = line.indexOf(' ');
  const cmd = sp === -1 ? line : line.slice(0, sp);
  const rest = sp === -1 ? '' : line.slice(sp + 1).trim();
  const nums = rest.split(/\s+/).map(Number);

  switch (cmd) {
    case 'goto': {
      const loaded = new Promise((resolve) => {
        const onMsg = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.method === 'Page.loadEventFired') {
            ws.removeEventListener('message', onMsg);
            resolve();
          }
        };
        ws.addEventListener('message', onMsg);
      });
      await send('Page.navigate', { url: rest });
      await Promise.race([loaded, sleep(30000)]);
      break;
    }
    case 'wait':
      await sleep(nums[0]);
      break;
    case 'waitlog': {
      const m = /^(.*?)(?:\s+(\d+))?$/.exec(rest);
      const re = new RegExp(m[1]);
      const timeout = Number(m[2] ?? 60000);
      if (consoleLines.some((l) => re.test(l))) break;
      const ok = await new Promise((resolve) => {
        const fn = (l) => {
          if (re.test(l)) {
            listeners.delete(fn);
            resolve(true);
          }
        };
        listeners.add(fn);
        setTimeout(() => {
          listeners.delete(fn);
          resolve(false);
        }, timeout);
      });
      if (!ok) {
        out(`${stamp()} TIMEOUT waiting for log /${m[1]}/`);
        exitCode = 1;
      }
      break;
    }
    case 'waiteval': {
      const sp2 = rest.indexOf(' ');
      const timeout = Number(rest.slice(0, sp2));
      const expr = rest.slice(sp2 + 1);
      const deadline = Date.now() + timeout;
      let ok = false;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expr)) {
            ok = true;
            break;
          }
        } catch {}
        await sleep(250);
      }
      if (!ok) {
        out(`${stamp()} TIMEOUT waiting for ${expr}`);
        exitCode = 1;
      }
      break;
    }
    case 'eval':
      try {
        out(`${stamp()} eval => ${JSON.stringify(await evaluate(rest))}`);
      } catch (e) {
        out(`${stamp()} eval error: ${e.message}`);
      }
      break;
    case 'shot': {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(path.dirname(path.resolve(rest)), { recursive: true });
      writeFileSync(rest, Buffer.from(data, 'base64'));
      out(`${stamp()} shot ${rest}`);
      break;
    }
    case 'tap':
      await touch('touchStart', [{ x: nums[0], y: nums[1], id: 1 }]);
      await sleep(60);
      await touch('touchEnd', []);
      break;
    case 'tap2':
      await touch('touchStart', [{ x: nums[0] - 30, y: nums[1], id: 1 }, { x: nums[0] + 30, y: nums[1], id: 2 }]);
      await sleep(60);
      await touch('touchEnd', []);
      break;
    case 'swipe': {
      const [x1, y1, x2, y2, ms = 300] = nums;
      const steps = Math.max(2, Math.round(ms / 16));
      await touch('touchStart', [{ x: x1, y: y1, id: 1 }]);
      for (let i = 1; i <= steps; i++) {
        await touch('touchMove', [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, id: 1 }]);
        await sleep(16);
      }
      await touch('touchEnd', []);
      break;
    }
    case 'swipe2': {
      // Two fingers 60 px apart moving together (scroll gesture).
      const [x1, y1, x2, y2, ms = 400] = nums;
      const steps = Math.max(2, Math.round(ms / 16));
      const pts = (x, y) => [{ x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 }];
      await touch('touchStart', pts(x1, y1));
      for (let i = 1; i <= steps; i++) {
        await touch('touchMove', pts(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps));
        await sleep(16);
      }
      await touch('touchEnd', []);
      break;
    }
    case 'tapn': {
      const [n, x, y] = nums;
      if (!Number.isInteger(n) || n < 1 || n > 5 || !Number.isFinite(x) || !Number.isFinite(y)) {
        out(`${stamp()} tapn: usage: tapn <n 1..5> <x> <y>`);
        exitCode = 2;
        break;
      }
      // n fingers 60 px apart in a row centred on x,y (n=2 is exactly tap2).
      const pts = Array.from({ length: n }, (_, i) => ({ x: x + (i - (n - 1) / 2) * 60, y, id: i + 1 }));
      await touch('touchStart', pts);
      await sleep(60);
      await touch('touchEnd', []);
      break;
    }
    case 'hold': {
      // Long-press drag: down, wait, drag, settle at the target, release.
      const [x1, y1, x2, y2, holdMs = 650, moveMs = 400] = nums;
      if (![x1, y1, x2, y2, holdMs, moveMs].every(Number.isFinite) || holdMs < 0 || moveMs < 0) {
        out(`${stamp()} hold: usage: hold <x1> <y1> <x2> <y2> [holdMs=650] [moveMs=400]`);
        exitCode = 2;
        break;
      }
      const steps = moveMs > 0 ? Math.max(2, Math.round(moveMs / 16)) : 0;
      await touch('touchStart', [{ x: x1, y: y1, id: 1 }]);
      await sleep(holdMs);
      for (let i = 1; i <= steps; i++) {
        await touch('touchMove', [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, id: 1 }]);
        await sleep(16);
      }
      if (steps === 0 && (x2 !== x1 || y2 !== y1)) await touch('touchMove', [{ x: x2, y: y2, id: 1 }]);
      await sleep(150); // let the engine poll the cursor at the target before the release
      await touch('touchEnd', []);
      break;
    }
    case 'move':
      await mouse('mouseMoved', nums[0], nums[1]);
      break;
    case 'click':
      await mouse('mouseMoved', nums[0], nums[1]);
      await sleep(50);
      await mouse('mousePressed', nums[0], nums[1], 'left', 1);
      await sleep(80);
      await mouse('mouseReleased', nums[0], nums[1], 'left', 0);
      break;
    case 'rclick':
      await mouse('mouseMoved', nums[0], nums[1]);
      await sleep(50);
      await mouse('mousePressed', nums[0], nums[1], 'right', 2);
      await sleep(80);
      await mouse('mouseReleased', nums[0], nums[1], 'right', 0);
      break;
    case 'key': {
      // Dispatched inside the page rather than through CDP input: headless
      // Chrome treats a CDP Escape as a browser-level key and hides the page.
      const codes = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, ' ': 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
      const isChar = rest.length === 1;
      const keyCode = codes[rest] ?? (isChar ? rest.toUpperCase().charCodeAt(0) : 0);
      const code = rest === ' ' ? 'Space' : isChar ? (/[0-9]/.test(rest) ? `Digit${rest}` : `Key${rest.toUpperCase()}`) : rest;
      await evaluate(`(() => {
        const target = document.getElementById('canvas') || document.activeElement || document.body;
        const init = { key: ${JSON.stringify(rest)}, code: ${JSON.stringify(code)}, keyCode: ${keyCode}, which: ${keyCode}, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        ${isChar ? `target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: ${rest.charCodeAt(0)}, keyCode: ${rest.charCodeAt(0)}, which: ${rest.charCodeAt(0)} }));` : ''}
        setTimeout(() => target.dispatchEvent(new KeyboardEvent('keyup', init)), 60);
      })()`);
      await sleep(90);
      break;
    }
    case 'text':
      await send('Input.insertText', { text: rest });
      break;
    case 'stack': {
      // Pause the page and print the JS/wasm call stack (who is running?).
      // With --debugger the domain is already enabled (enabling needs an
      // answer from the page, which a frozen page cannot give) and stays on.
      if (!DEBUGGER) await send('Debugger.enable');
      debuggerOn = true;
      const paused = new Promise((resolve) => {
        const onMsg = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.method === 'Debugger.paused') {
            ws.removeEventListener('message', onMsg);
            resolve(m.params);
          }
        };
        ws.addEventListener('message', onMsg);
      });
      await send('Debugger.pause');
      const info = await Promise.race([paused, sleep(5000).then(() => null)]);
      if (info) {
        const frames = info.callFrames.slice(0, Number(rest) || 25).map((f) => f.functionName || '(anonymous)');
        out(`${stamp()} stack: ${frames.join(' < ')}`);
        await send('Debugger.resume');
      } else {
        out(`${stamp()} stack: page did not pause (idle)`);
      }
      if (!DEBUGGER) {
        await send('Debugger.disable');
        debuggerOn = false;
        catchOn = false;
      }
      break;
    }
    case 'catch': {
      // From now on, log the call stack of every thrown exception (including
      // caught ones such as Emscripten's ExitStatus) and keep going.
      await send('Debugger.enable');
      await send('Debugger.setPauseOnExceptions', { state: 'all' });
      debuggerOn = true;
      catchOn = true;
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method !== 'Debugger.paused' || !['exception', 'promiseRejection'].includes(m.params.reason)) return;
        const d = m.params.data || {};
        const frames = m.params.callFrames.slice(0, 30).map((f) => f.functionName || '(anonymous)');
        out(`${stamp()} THROWN ${d.className || ''} ${String(d.description || d.value || '').split('\n')[0]} :: ${frames.join(' < ')}`);
        send('Debugger.resume').catch(() => {});
      });
      break;
    }
    case 'fresh': {
      // Replace the page by a new tab of the same browser (same profile and
      // storage). Open the new one before closing the old so the browser never
      // has zero pages.
      const oldTargetId = page.targetId;
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
      ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
      page = { targetId };
      consoleLines.length = 0;
      await setupPage();
      await send('Target.closeTarget', { targetId: oldTargetId }, false);
      out(`${stamp()} fresh: new page ${targetId.slice(0, 8)} (old ${oldTargetId.slice(0, 8)} closed)`);
      break;
    }
    case 'end':
      ended = true;
      break;
    case 'log':
      out(`${stamp()} -- ${rest}`);
      break;
    default:
      out(`${stamp()} unknown command: ${cmd}`);
      exitCode = 2;
  }
}

let ended = false;
async function runScriptLine(raw) {
  const line = raw.replace(/(^|\s)#.*$/, '').trim();
  if (!line) return;
  // A leading '!' fires the command without waiting for it to finish
  // (useful when the command is what freezes the page).
  if (line[0] === '!') run(line.slice(1).trim()).catch((e) => out(`${stamp()} (async) ${e.message}`));
  else await run(line);
}

// --follow: run lines as they are appended to the script file, until `end`.
async function follow() {
  statSync(scriptPath); // must exist (throws like a missing script does without --follow)
  let offset = 0; // bytes of the file read so far
  let tail = Buffer.alloc(0); // bytes after the last newline, waiting for the rest of the line
  let tailSince = 0;
  let announced = false;
  while (!ended) {
    if (ws.readyState !== WebSocket.OPEN) {
      out(`${stamp()} follow: browser connection closed`);
      exitCode = 3;
      break;
    }
    let size = null;
    try { size = statSync(scriptPath).size; } catch {} // briefly missing during a rename: retry
    if (size !== null && size < offset) {
      out(`${stamp()} follow: ${scriptPath} shrank, reading it again from the first line`);
      offset = 0;
      tail = Buffer.alloc(0);
    }
    if (size !== null && size > offset) {
      const fd = openSync(scriptPath, 'r');
      try {
        const b = Buffer.alloc(size - offset);
        const n = readSync(fd, b, 0, b.length, offset);
        offset += n;
        tail = Buffer.concat([tail, b.subarray(0, n)]);
        tailSince = Date.now();
      } finally {
        closeSync(fd);
      }
    }
    let nl;
    while (!ended && (nl = tail.indexOf(10)) !== -1) {
      const raw = tail.subarray(0, nl).toString('utf8');
      tail = tail.subarray(nl + 1);
      await runScriptLine(raw);
    }
    if (!ended && tail.length && Date.now() - tailSince >= 1000) {
      const raw = tail.toString('utf8');
      tail = Buffer.alloc(0);
      await runScriptLine(raw);
    }
    if (ended) break;
    if (!announced) {
      announced = true;
      out(`${stamp()} follow: waiting for lines appended to ${scriptPath} (finish with a line "end")`);
    }
    await sleep(100);
  }
}

try {
  if (FOLLOW) {
    await follow();
  } else {
    const lines = readFileSync(scriptPath, 'utf8').split('\n');
    for (const raw of lines) {
      await runScriptLine(raw);
      if (ended) break;
    }
  }
} catch (e) {
  out(`${stamp()} DRIVER ERROR: ${e.stack || e}`);
  exitCode = 3;
}

ws.close();
process.exit(exitCode);
