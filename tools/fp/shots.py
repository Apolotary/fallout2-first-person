"""Scripted viewer screenshots through tools/webtest.mjs (headless Chrome).

    python3 tools/fp/shots.py NAME [--map kladwtwn] [--size 1280x800] [--mobile] [--query "&roof=0"] VIEW...

A VIEW is one of
    hx,hy:yaw[:pitch]        stand on a hex, look along a heading (degrees, 0 = up the game's screen)
    hx,hy>tx,ty[@height]     stand on a hex, look at another hex (height in world units, default 0.8)
    iso:hx,hy  top:hx,hy     the game's camera / the straight-down debug view centred on a hex

Writes run/fp-shots/NAME-<n>.png and prints what the crosshair names in each
first-person view. The viewer server (python tools/serve.py) must be running.
"""
import argparse
import os
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "run", "fp-shots")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name")
    parser.add_argument("views", nargs="+", metavar="VIEW")
    parser.add_argument("--map", default="kladwtwn")
    parser.add_argument("--size", default="1280x800")
    parser.add_argument("--mobile", action="store_true")
    parser.add_argument("--query", default="&debug=1&anim=0", help="extra URL parameters")
    parser.add_argument("--base", default="http://127.0.0.1:8000/", help="viewer server URL")
    args = parser.parse_args()

    os.makedirs(OUT, exist_ok=True)
    base = f"{args.base.rstrip('/')}/?map={args.map}&start=0{args.query}"
    lines, loaded = [], None
    for n, view in enumerate(args.views):
        mode = view.split(":")[0] if view.startswith(("iso:", "top:")) else "fp"
        if mode != "fp":
            lines += [f"goto {base}&{mode}=1&pos={view.split(':')[1]}", "waitlog \\[fp\\] ready 30000"]
            loaded = None
        else:
            if loaded != "fp":
                lines += [f"goto {base}", "waitlog \\[fp\\] ready 30000"]
                loaded = "fp"
            if ">" in view:
                here, target = view.split(">")
                target, _, height = target.partition("@")
                lines.append(f"eval fp.goto({here}, 0), fp.lookAt({target}, {height or 0.8}), 1")
            else:
                here, yaw, *pitch = view.split(":")
                lines.append(f"eval fp.goto({here}, {yaw}, {pitch[0] if pitch else 0}), 1")
        lines += ["wait 300", f"shot {os.path.join(OUT, f'{args.name}-{n}.png')}"]
        if mode == "fp":
            lines.append("eval 'looking at: ' + (fp.scene.names[fp.state.lookingAt] || '')")
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as script:
        script.write("\n".join(lines) + "\n")
    command = ["node", os.path.join(ROOT, "tools", "webtest.mjs"), "--size", args.size, "--timeout", "120000"]
    result = subprocess.run(command + (["--mobile"] if args.mobile else []) + [script.name],
                            capture_output=True, text=True)
    os.unlink(script.name)
    for line in result.stdout.splitlines():
        if "looking at" in line or "shot" in line or "rror" in line:
            print(line)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
