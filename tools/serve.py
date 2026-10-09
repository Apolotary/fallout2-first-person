#!/usr/bin/env python3
"""Serve the viewer using Python's standard library.

    python tools/serve.py
    python tools/serve.py --port 8080
    python tools/serve.py --lan

Only the viewer's static files are served. The default listens on this computer
only; --lan allows other devices on the local network to connect. Addresses are
printed to the console, never inserted into a page or saved in a file.
"""
import argparse
import ipaddress
import shutil
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from fp import VIEWER

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


class ViewerHandler(BaseHTTPRequestHandler):
    """A read-only handler, with no directory listings or route outside the page."""

    server_version = "ViewerServer"
    sys_version = ""

    def file_path(self):
        try:
            path = unquote(urlsplit(self.path).path, errors="strict")
            if not path.startswith("/") or "\\" in path or "\0" in path:
                return None
            parts = [part for part in path.split("/") if part]
            if any(part.startswith(".") for part in parts):
                return None
            root = self.server.viewer_root
            target = root.joinpath(*parts)
            if target.is_dir():
                target /= "index.html"
            target = target.resolve()
            target.relative_to(root)
            if target.suffix.lower() not in CONTENT_TYPES or not target.is_file():
                return None
            return target
        except (OSError, RuntimeError, UnicodeError, ValueError):
            return None

    def send_file(self, body):
        path = self.file_path()
        if path is None:
            self.send_error(404, "File not found")
            return
        try:
            with path.open("rb") as source:
                self.send_response(200)
                self.send_header("Content-Type", CONTENT_TYPES[path.suffix.lower()])
                self.send_header("Content-Length", str(path.stat().st_size))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                if body:
                    shutil.copyfileobj(source, self.wfile)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            # The file can disappear between checking and opening it.
            self.send_error(404, "File not found")

    def do_GET(self):
        self.send_file(True)

    def do_HEAD(self):
        self.send_file(False)

    def refuse_write(self):
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD")
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_POST = do_PUT = do_PATCH = do_DELETE = refuse_write

    def log_message(self, format, *args):
        pass


def make_server(port=8000, lan=False):
    server = ThreadingHTTPServer(("0.0.0.0" if lan else "127.0.0.1", port), ViewerHandler)
    server.viewer_root = VIEWER.resolve()
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000, help="listen port (default: 8000)")
    parser.add_argument("--lan", action="store_true", help="allow devices on the local network to connect")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    if not VIEWER.is_dir():
        parser.exit(2, "Viewer folder is missing; run from a complete repository copy.\n")
    try:
        server = make_server(args.port, args.lan)
    except OSError as error:
        parser.exit(2, f"Cannot start the viewer server: {error}; try another --port.\n")
    port = server.server_address[1]
    print(f"Viewer: http://127.0.0.1:{port}/", flush=True)
    if args.lan:
        try:
            addresses = {row[4][0] for row in socket.getaddrinfo(socket.gethostname(), port, socket.AF_INET)}
        except OSError:
            addresses = set()
        for address in sorted(addresses):
            if not ipaddress.ip_address(address).is_loopback:
                print(f"Local network: http://{address}:{port}/", flush=True)
        if not addresses or all(ipaddress.ip_address(address).is_loopback for address in addresses):
            print(f"Local network enabled on port {port}; use this computer's network address.", flush=True)
    print("Press Ctrl-C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
