#!/usr/bin/env python3
"""Film the first-person viewer: every frame of a described shot, drawn exactly and saved losslessly.

    python3 tools/fp/capture.py SHOT.json [SHOT.json ...] [--out DIR] [--frames A:B] [--jobs N]
                                [--mp4] [--sheet EVERY] [--same-as DIR] [--no-verify] [--small]

Drives headless Chrome (DevTools protocol over a pipe; device scale 1, the page exactly the
shot's size, no browser chrome) at the viewer's filming mode, ?capture=1
(viewer/capture.js): there the page has no clock of its own, and a picture is a
function of the frame number alone. For every frame this asks the page to draw it, waits for
the page's promise that it is on screen, takes a PNG screenshot and writes it to
run/trailer-fp/<name>/frame-%05d.png (frame n is the shot at n / fps seconds; numbering
starts at 0). capture.json beside the frames holds the shot, what the page said about it,
every frame's camera, the timings and whatever the page's console complained of.

A shot file holds one shot, or a list of shots:

    { "name": "klamath-walk",            the folder under run/trailer-fp/
      "map": "kladwtwn",                 a folder of viewer/data/
      "size": [1280, 720], "fps": 30, "duration": 3,
      "look":   { "retro": true, "hud": true, "time": "day", "fov": 62, ... },
      "camera": { "keys": [ {"t": 0, "pos": [109, 101], "yaw": 76}, {"t": 3, "pos": [97, 105], "yaw": 60} ],
                  "ease": "inout", "bob": 1 },
      "events": [ {"t": 1.5, "examine": true} ] }

look, camera and events are described at the top of viewer/capture.js (retro /
smooth, the game's bar, time of day and its change during a shot, field of view; keys by hex
or ground position, easing, looking along the path or at a target, walk bob; messages in the
bar's monitor). In a normal visit of the page, fp.pose() in the browser's console gives the
place one stands at as a camera key.

Options
    --out DIR       where the frames go (one shot only; default run/trailer-fp/<name>)
    --frames A:B    only frames A .. B-1 (either may be left out)
    --jobs N        N browsers at once, each drawing every Nth frame (frames do not depend on
                    one another, so the result is the same)
    --mp4           also assemble <DIR>/<name>.mp4 with ffmpeg (H.264, yuv420p) to look at
    --sheet EVERY   also write <DIR>/sheet.png, a contact sheet of every EVERYth frame
    --same-as DIR   compare the frames written with those of an earlier run, pixel for pixel
    --no-verify     do not check each screenshot against the page's own number of its picture.
                    (With the check, a screenshot that is not exactly the picture just drawn
                    is taken again; that is what makes a stale frame impossible.)
    --small         smaller PNG files (Chrome's slower encoder; the pixels are the same)
    --base URL      the viewer (default http://127.0.0.1:8000/; tools/serve.py must be running)

Exit status: 0 = all frames written (and equal to --same-as, if asked), 1 = not.
"""
import argparse
import base64
import io
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "run", "trailer-fp")
CHROME = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome"
BASE = "http://127.0.0.1:8000/"
RETAKES = 8                     # screenshots of one frame before giving up on it


class Chrome:
    """A headless Chrome with one page, spoken to over --remote-debugging-pipe."""

    def __init__(self, width, height, chrome=CHROME):
        self.profile = tempfile.mkdtemp(prefix="fp-capture-")
        to_chrome, mine_out = os.pipe()
        mine_in, from_chrome = os.pipe()
        args = [
            chrome, "--headless=new", "--remote-debugging-pipe", f"--user-data-dir={self.profile}",
            f"--window-size={width},{height}", "--force-device-scale-factor=1", "--force-color-profile=srgb",
            "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
            "--disable-background-networking", "--disable-sync", "--mute-audio", "--enable-unsafe-swiftshader",
            # A headless page counts as a background tab; and nothing waits for a monitor's refresh.
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows", "--disable-features=IntensiveWakeUpThrottling",
            "--disable-frame-rate-limit", "--disable-gpu-vsync",
            # The bar and the minimap are 2D canvases. Chrome draws those on the GPU or not as it sees fit,
            # browser by browser, and the two ways round edges differently: always the same way here.
            "--disable-accelerated-2d-canvas", "about:blank",
        ]
        # Chrome reads commands from descriptor 3 and writes answers to 4.
        self.process = subprocess.Popen(["sh", "-c", f'exec "$0" "$@" 3<&{to_chrome} 4>&{from_chrome}', *args],
                                        pass_fds=(to_chrome, from_chrome), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.close(to_chrome)
        os.close(from_chrome)
        self.out, self.inp = mine_out, mine_in
        self.buffer = bytearray()
        self.next_id = 0
        self.session = None
        self.console = []           # what the page logged: (kind, text)
        targets = self.call("Target.getTargets")["targetInfos"]
        page = next(t for t in targets if t["type"] == "page")
        self.session = self.call("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})["sessionId"]
        for domain in ("Page", "Runtime", "Log"):
            self.call(domain + ".enable")
        self.call("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False})

    def close(self):
        try:
            self.process.kill()
            self.process.wait(5)
        except Exception:
            pass
        for fd in (self.out, self.inp):
            try:
                os.close(fd)
            except OSError:
                pass
        shutil.rmtree(self.profile, ignore_errors=True)

    def read(self, timeout):
        """The next message from Chrome."""
        deadline = time.monotonic() + timeout
        while True:
            end = self.buffer.find(b"\0")
            if end >= 0:
                message = json.loads(self.buffer[:end])
                del self.buffer[:end + 1]
                return message
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([self.inp], [], [], left)[0]:
                raise TimeoutError(f"Chrome said nothing for {timeout:.0f} s")
            chunk = os.read(self.inp, 1 << 20)
            if not chunk:
                raise RuntimeError("Chrome closed the pipe (it exited)")
            self.buffer += chunk

    def call(self, method, params=None, timeout=60):
        self.next_id += 1
        message = {"id": self.next_id, "method": method, "params": params or {}}
        if self.session:
            message["sessionId"] = self.session
        os.write(self.out, json.dumps(message).encode() + b"\0")
        while True:
            answer = self.read(timeout)
            if answer.get("id") == self.next_id:
                if "error" in answer:
                    raise RuntimeError(f"{method}: {answer['error'].get('message')}")
                return answer["result"]
            self.event(answer)

    def event(self, message):
        method, params = message.get("method"), message.get("params", {})
        if method == "Runtime.consoleAPICalled":
            text = " ".join(str(a.get("value", a.get("description", a.get("type")))) for a in params["args"])
            self.console.append((params["type"], text))
        elif method == "Runtime.exceptionThrown":
            details = params["exceptionDetails"]
            self.console.append(("exception", details.get("exception", {}).get("description") or details.get("text", "")))
        elif method == "Log.entryAdded":
            entry = params["entry"]
            self.console.append((entry["level"], f"{entry['text']} {entry.get('url', '')}".strip()))

    def evaluate(self, expression, timeout=60):
        """The value of a JavaScript expression; a promise is waited for."""
        result = self.call("Runtime.evaluate", {"expression": expression, "awaitPromise": True, "returnByValue": True}, timeout)
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            raise RuntimeError(details.get("exception", {}).get("description") or details.get("text"))
        return result["result"].get("value")

    def screenshot(self, fast=True):
        return base64.b64decode(self.call("Page.captureScreenshot", {"format": "png", "optimizeForSpeed": fast})["data"])


# The page's number of a picture (capture.js, checksum): over the pixels of the top `rows` rows
# except the row ranges of `skip` (under the crosshair, the minimap),
# (R + 3 G + 5 B) * (1 + (31 x + 17 y) mod 1024), modulo 2^32.
def checksum(rgb, rows, skip=(), cache=None):
    """cache: a dict of the caller's (one per thread) that keeps the weights of the last picture."""
    width, key = rgb.shape[1], (rows, rgb.shape[1], tuple(map(tuple, skip)))
    weights = cache.get(key) if cache is not None else None
    if weights is None:
        y, x = np.mgrid[0:rows, 0:width]
        weights = (1 + ((31 * x + 17 * y) & 1023)).astype(np.int64)
        for a, b in skip:
            weights[a:b] = 0
        if cache is not None:
            cache.clear()           # each is the picture's size, and a shot has few different ones
            cache[key] = weights
    part = rgb[:rows].astype(np.int64)
    return int(((part[..., 0] + 3 * part[..., 1] + 5 * part[..., 2]) * weights).sum() % 2 ** 32)


def pixels(data):
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))


def page_url(shot, base):
    query = {"map": shot["map"], "capture": 1, **shot.get("query", {})}
    return base + "?" + urllib.parse.urlencode(query)


class Worker:
    """One browser on the shot's page."""

    def __init__(self, shot, base, chrome):
        width, height = shot["size"]
        self.shot, self.size = shot, (width, height)
        self.chrome = Chrome(width, height, chrome)
        self.times = {"draw": 0.0, "shot": 0.0, "check": 0.0, "write": 0.0}
        self.retakes = 0
        self.weights = {}
        self.chrome.call("Page.navigate", {"url": page_url(shot, base)})
        deadline = time.monotonic() + 60
        while not self.chrome.evaluate("!!(window.fp && window.fp.capture)"):
            failed = self.chrome.evaluate("(() => { const o = document.getElementById('overlay'); return o && o.classList.contains('error')"
                                          " ? document.getElementById('status').textContent : '' })()")
            if failed:
                raise RuntimeError(f"the page did not start: {failed}")
            if time.monotonic() > deadline:
                raise TimeoutError("the page was not ready after 60 s (is the viewer server running at --base?)")
            time.sleep(0.05)
        description = {key: shot[key] for key in ("fps", "duration", "look", "camera", "events") if key in shot}
        self.summary = self.chrome.evaluate(f"fp.capture.shot({json.dumps(description)})")
        self.info = self.chrome.evaluate("fp.capture.info()")

    def frame(self, n, path, verify=True, fast=True):
        """Draw frame n, write it; returns what the page said of it."""
        start = time.perf_counter()
        said = self.chrome.evaluate(f"fp.capture.frame({n}, {{sum: {'true' if verify else 'false'}}})")
        drawn = time.perf_counter()
        self.times["draw"] += drawn - start
        for attempt in range(RETAKES):
            before = time.perf_counter()
            data = self.chrome.screenshot(fast)
            taken = time.perf_counter()
            self.times["shot"] += taken - before
            if not verify:
                break
            rgb = pixels(data)
            ok = (rgb.shape[:2] == (self.size[1], self.size[0]) and rgb.shape[1] == said["width"]
                  and checksum(rgb, said["rows"], said.get("skip", ()), self.weights) == said["sum"])
            self.times["check"] += time.perf_counter() - taken
            if ok:
                break
            self.retakes += 1
            time.sleep(0.02 * (attempt + 1))
        else:
            raise RuntimeError(f"frame {n}: {RETAKES} screenshots, none of them the picture the page drew "
                               f"(screenshot {rgb.shape[1]}x{rgb.shape[0]}, page {said['width']} wide)")
        before = time.perf_counter()
        with open(path, "wb") as f:
            f.write(data)
        self.times["write"] += time.perf_counter() - before
        return said

    def close(self):
        self.chrome.close()


def capture(shot, out, frames=None, jobs=1, verify=True, fast=True, base=BASE, chrome=CHROME, quiet=False):
    """Film a shot into `out`. Returns the report (also written to out/capture.json)."""
    say = (lambda *a: None) if quiet else (lambda *a: print(*a, flush=True))
    os.makedirs(out, exist_ok=True)
    started = time.perf_counter()
    workers, errors = [None] * jobs, []

    def start(k):
        try:
            workers[k] = Worker(shot, base, chrome)
        except Exception as error:      # noqa: BLE001 - reported below
            errors.append(error)
    threads = [threading.Thread(target=start, args=(k,)) for k in range(jobs)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    try:
        if errors:
            raise errors[0]
        summary, info = workers[0].summary, workers[0].info
        gpus = sorted({worker.info["gpu"] for worker in workers})
        if len(gpus) > 1:
            raise RuntimeError(f"the browsers do not draw with the same GPU, their frames would not match: {gpus}")
        total = summary["frames"]
        first, last = frames if frames else (0, total)
        first, last = max(0, first or 0), min(total, total if last is None else last)
        wanted = list(range(first, last))
        if frames is None:              # a full run: no frames of an earlier, longer one are left behind
            for name in os.listdir(out):
                if name.startswith("frame-") and name.endswith(".png"):
                    os.unlink(os.path.join(out, name))
        say(f"{shot['name']}: {shot['map']} {shot['size'][0]}x{shot['size'][1]}, {total} frames at {summary['fps']} fps "
            f"({summary['duration']} s), camera path {summary['length']} units, mean {summary['speed']['mean']} units/s "
            f"(walking is {summary['speed']['walk']}), fastest {summary['speed']['fastest']}")
        say(f"  GPU: {info['gpu']}; picture {info['picture']}, bar {info['bar']}")
        for warning in summary["warnings"]:
            say(f"  WARNING: {warning}")
        ready = time.perf_counter()
        said, ended = {}, []

        def run(k):
            try:
                for n in wanted[k::jobs]:
                    said[n] = workers[k].frame(n, os.path.join(out, f"frame-{n:05d}.png"), verify, fast)
            except Exception as error:  # noqa: BLE001
                errors.append(error)
            ended.append(time.perf_counter())
        threads = [threading.Thread(target=run, args=(k,)) for k in range(jobs)]
        for thread in threads:
            thread.start()
        tick = time.monotonic()
        while any(thread.is_alive() for thread in threads):
            time.sleep(0.02)
            if not quiet and sys.stdout.isatty() and time.monotonic() - tick > 1:
                tick = time.monotonic()
                print(f"\r  {len(said)} / {len(wanted)} frames", end="", flush=True)
        for thread in threads:
            thread.join()
        if errors:
            raise errors[0]
        done = max(ended)
        console = [list(line) for worker in workers for line in worker.chrome.console if line[0] in ("error", "warning", "exception")]
    finally:
        for worker in workers:
            if worker:
                worker.close()

    count = len(wanted)
    seconds = done - ready
    per = {key: sum(worker.times[key] for worker in workers) / max(1, count) * 1000 for key in workers[0].times}
    size = sum(os.path.getsize(os.path.join(out, f"frame-{n:05d}.png")) for n in wanted)
    timings = {
        "frames": count, "jobs": jobs, "verified": verify,
        "start_seconds": round(ready - started, 2), "capture_seconds": round(seconds, 2),
        "frames_per_second": round(count / seconds, 2) if seconds > 0 else None,
        "ms_per_frame": {key: round(value, 1) for key, value in per.items()},
        "retakes": sum(worker.retakes for worker in workers),
        "bytes": size,
    }
    report = {"shot": shot, "page": info, "summary": summary, "timings": timings, "console": console,
              "frames": [dict(said[n]) for n in wanted]}
    with open(os.path.join(out, "capture.json"), "w") as f:
        json.dump(report, f, indent=1)
    say(f"  {count} frames in {seconds:.1f} s = {timings['frames_per_second']} frames/s with {jobs} browser(s) "
        f"(start-up {timings['start_seconds']} s); per frame and browser: draw {per['draw']:.0f} ms, screenshot {per['shot']:.0f} ms, "
        f"check {per['check']:.0f} ms, write {per['write']:.0f} ms; {timings['retakes']} screenshots retaken; "
        f"{size / 1e6:.1f} MB in {os.path.relpath(out, ROOT)}")
    if console:
        say(f"  the page's console: {len(console)} errors or warnings, first: {console[0]}")
    return report


def same(out, other, numbers):
    """Compare frames of two runs pixel for pixel: (compared, different, missing)."""
    different, missing = [], []
    for n in numbers:
        a, b = (os.path.join(folder, f"frame-{n:05d}.png") for folder in (out, other))
        if not os.path.exists(b):
            missing.append(n)
        elif not np.array_equal(pixels(open(a, "rb").read()), pixels(open(b, "rb").read())):
            different.append(n)
    return len(numbers) - len(missing), different, missing


def sheet(out, numbers, every, path, columns=6, width=320):
    """A contact sheet of every `every`th frame, numbered."""
    chosen = numbers[::every]
    images = [Image.open(os.path.join(out, f"frame-{n:05d}.png")).convert("RGB") for n in chosen]
    height = round(width * images[0].height / images[0].width)
    rows = -(-len(images) // columns)
    page = Image.new("RGB", (columns * width, rows * height), (0, 0, 0))
    draw = ImageDraw.Draw(page)
    for i, (n, image) in enumerate(zip(chosen, images)):
        x, y = i % columns * width, i // columns * height
        page.paste(image.resize((width, height), Image.LANCZOS), (x, y))
        draw.rectangle([x, y, x + 38, y + 12], fill=(0, 0, 0))
        draw.text((x + 3, y + 1), f"{n:05d}", fill=(60, 240, 122))
    page.save(path)
    return path


def mp4(out, name, fps, first=0):
    path = os.path.join(out, f"{name}.mp4")
    command = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-start_number", str(first),
               "-i", os.path.join(out, "frame-%05d.png"), "-c:v", "libx264", "-preset", "medium", "-crf", "14",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]
    subprocess.run(command, check=True)
    return path


def load(path):
    with open(path) as f:
        data = json.load(f)
    shots = data if isinstance(data, list) else data.get("shots", [data])
    for shot in shots:
        for key in ("name", "map", "duration", "camera"):
            if key not in shot:
                raise SystemExit(f"{path}: a shot needs \"{key}\"")
        shot.setdefault("size", [1280, 720])
        shot.setdefault("fps", 30)
    return shots


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("shots", nargs="+", metavar="SHOT.json")
    parser.add_argument("--out")
    parser.add_argument("--frames", help="A:B")
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--mp4", action="store_true")
    parser.add_argument("--sheet", type=int, metavar="EVERY")
    parser.add_argument("--same-as", metavar="DIR")
    parser.add_argument("--no-verify", action="store_true")
    parser.add_argument("--small", action="store_true")
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--chrome", default=CHROME)
    args = parser.parse_args()

    shots = [shot for path in args.shots for shot in load(path)]
    if args.out and len(shots) > 1:
        parser.error("--out takes exactly one shot")
    frames = None
    if args.frames:
        a, _, b = args.frames.partition(":")
        frames = (int(a) if a else None, int(b) if b else None)
    failed = False
    for shot in shots:
        out = args.out or os.path.join(OUT, shot["name"])
        report = capture(shot, out, frames, max(1, args.jobs), not args.no_verify, not args.small, args.base, args.chrome)
        numbers = [frame["n"] for frame in report["frames"]]
        if args.same_as:
            compared, different, missing = same(out, args.same_as, numbers)
            print(f"  against {args.same_as}: {compared} frames compared, {len(different)} different"
                  + (f" (first: {different[:5]})" if different else "") + (f", {len(missing)} missing there" if missing else ""))
            failed = failed or bool(different or missing)
        if args.sheet and numbers:
            print(f"  {os.path.relpath(sheet(out, numbers, args.sheet, os.path.join(out, 'sheet.png')), ROOT)}")
        if args.mp4 and numbers:
            print(f"  {os.path.relpath(mp4(out, shot['name'], report['summary']['fps'], numbers[0]), ROOT)}")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
