from __future__ import annotations

import argparse
import gzip
import json
import subprocess
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from posixpath import normpath
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from unitree_deploy.robot_model.robot_config import DEFAULT_ROBOT, DEFAULT_TERRAIN
from policy_web_viewer.simulator import OnlineDemoSimulator, build_config


STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
}


class DemoServer(ThreadingHTTPServer):
    def __init__(self, address, simulator: OnlineDemoSimulator):
        super().__init__(address, DemoHandler)
        self.simulator = simulator


class DemoHandler(BaseHTTPRequestHandler):
    server: DemoServer

    def log_message(self, fmt: str, *args) -> None:
        # Keep the terminal readable; simulator status is available in the web UI.
        return

    def send_error(self, code, message=None, explain=None) -> None:
        try:
            super().send_error(code, message, explain)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            self._send_static("index.html")
        elif path == "/api/scene":
            self._send_json(self.server.simulator.scene_description())
        elif path == "/api/frame":
            query = parse_qs(parsed.query)
            include_contacts = query.get("contacts", ["0"])[0] in ("1", "true", "yes")
            self._send_json(self.server.simulator.frame(include_contacts=include_contacts))
        elif path == "/api/status":
            self._send_json(self.server.simulator.status())
        elif path.startswith("/static/"):
            self._send_static(path.removeprefix("/static/"))
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
            if path == "/api/command":
                self.server.simulator.set_command(payload.get("command", [0.0, 0.0, 0.0]))
                self._send_json(self.server.simulator.status())
            elif path == "/api/drag":
                self.server.simulator.set_drag_force(payload)
                self._send_json({"ok": True})
            elif path == "/api/control":
                self._control(payload)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            self._send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def _control(self, payload: dict) -> None:
        action = str(payload.get("action", ""))
        simulator = self.server.simulator
        if action == "start":
            simulator.set_running(True)
        elif action == "pause":
            simulator.set_running(False)
        elif action == "reset":
            simulator.reset()
        elif action == "switch_policy":
            simulator.switch_next_policy()
        else:
            raise ValueError(f"unknown control action: {action}")
        self._send_json(simulator.status())

    def _send_static(self, name: str) -> None:
        try:
            if "\\" in name:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            clean_name = normpath("/" + name).lstrip("/")
            parts = [part for part in clean_name.split("/") if part]
            if not parts or any(part in (".", "..") for part in parts):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            resource = resources.files("policy_web_viewer.static")
            for part in parts:
                resource = resource / part
            if not resource.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            data = resource.read_bytes()
            content_type = STATIC_TYPES.get(Path(clean_name).suffix, "application/octet-stream")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        try:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            encoding = ""
            if len(data) > 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
                data = gzip.compress(data, compresslevel=5)
                encoding = "gzip"
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            if encoding:
                self.send_header("Content-Encoding", encoding)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        data = self.rfile.read(length)
        payload = json.loads(data.decode("utf-8"))
        if not isinstance(payload, dict):
            raise TypeError("request body must be a JSON object")
        return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a browser demo for an ONNX policy in MuJoCo.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--robot", default=DEFAULT_ROBOT)
    parser.add_argument("--model-xml", type=Path, help="Optional MuJoCo XML override.")
    parser.add_argument("--terrain", default=DEFAULT_TERRAIN)
    parser.add_argument("--ckpt", type=Path, help="Checkpoint directory containing policy.yaml.")
    parser.add_argument("--multi-ckpt", type=Path, help="Multi-policy manifest.")
    parser.add_argument("--paused", action="store_true", help="Start with physics paused.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    ensure_api_frontend_built()
    config = build_config(
        ckpt=args.ckpt,
        multi_ckpt=args.multi_ckpt,
        robot=args.robot,
        model_xml=args.model_xml,
        terrain=args.terrain,
        auto_start=not args.paused,
    )
    simulator = OnlineDemoSimulator(config)
    simulator.start()
    server = DemoServer((args.host, args.port), simulator)
    url = f"http://{args.host}:{args.port}"
    print(f"[policy-web-viewer] serving {url}  robot={config.robot.name} ckpt={config.ckpt_dir}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        simulator.stop()


def ensure_api_frontend_built() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    package_json = repo_root / "package.json"
    frontend_root = repo_root / "frontend"
    static_index = repo_root / "src" / "policy_web_viewer" / "static" / "index.html"
    if not package_json.exists() or not frontend_root.exists():
        return
    source_paths = [
        frontend_root / "index.html",
        *frontend_root.joinpath("src").glob("**/*"),
        package_json,
    ]
    latest_source = max((path.stat().st_mtime for path in source_paths if path.is_file()), default=0)
    static_mtime = static_index.stat().st_mtime if static_index.exists() else 0
    if static_mtime >= latest_source:
        return
    try:
        subprocess.run(["npm", "run", "build:api"], cwd=repo_root, check=True)
    except FileNotFoundError as exc:
        if static_index.exists():
            print("[policy-web-viewer] npm not found; using existing static frontend", flush=True)
            return
        raise RuntimeError("npm is required to build the policy-web-viewer frontend") from exc
    except subprocess.CalledProcessError as exc:
        if static_index.exists():
            print("[policy-web-viewer] frontend build failed; using existing static frontend", flush=True)
            return
        raise RuntimeError("failed to build the policy-web-viewer frontend") from exc


if __name__ == "__main__":
    main()
