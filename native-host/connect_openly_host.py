#!/usr/bin/env python3
"""Connect Openly native host — lets the Firefox extension start/stop the bridge.

A WebExtension cannot launch processes on its own, so Firefox starts THIS
script on demand (native messaging, stdio framing) and it manages the bridge
server subprocess for the extension's Start/Stop buttons and auto-start.

Protocol (one JSON message per launch, like sendNativeMessage):
  {"cmd": "start"}  -> launch bridge detached, wait for port  -> {ok, running, pid, managed}
  {"cmd": "stop"}   -> SIGTERM (then SIGKILL) the managed pid -> {ok, running}
  {"cmd": "status"} -> {ok, running, pid, managed}

Stdlib only.
"""
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time

APP_DIR = os.path.expanduser("~/.cache/connect-openly")
PID_FILE = os.path.join(APP_DIR, "bridge.pid")
LOG_FILE = os.path.join(APP_DIR, "bridge.log")
HOST, PORT = "127.0.0.1", 4973
SERVER_PY = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge", "server.py"))


def port_open():
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect((HOST, PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def read_pid():
    try:
        return int(open(PID_FILE).read().strip())
    except (OSError, ValueError):
        return None


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just not ours to signal


def do_start():
    pid = read_pid()
    if port_open():
        return {"ok": True, "running": True, "pid": pid,
                "managed": bool(pid and pid_alive(pid)),
                "note": "bridge already running"}
    os.makedirs(APP_DIR, exist_ok=True)
    logf = open(LOG_FILE, "ab")
    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", SERVER_PY, "--port", str(PORT)],  # -u: unbuffered so bridge.log fills in real time
            stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
            start_new_session=True, close_fds=True)
    finally:
        logf.close()
    with open(PID_FILE, "w") as f:
        f.write(str(proc.pid))
    for _ in range(40):  # ~4s for the port to come up
        if port_open():
            return {"ok": True, "running": True, "pid": proc.pid, "managed": True}
        time.sleep(0.1)
    return {"ok": False, "running": False, "error": f"server started (pid {proc.pid}) but port {PORT} never opened — see {LOG_FILE}"}


def do_stop():
    pid = read_pid()
    if pid and pid_alive(pid):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        for _ in range(30):
            if not pid_alive(pid) or not port_open():
                break
            time.sleep(0.1)
        if pid_alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            time.sleep(0.5)
        try:
            os.unlink(PID_FILE)
        except OSError:
            pass
        return {"ok": True, "running": port_open()}
    if port_open():
        return {"ok": True, "running": True, "managed": False,
                "note": "bridge is running but was not started by the extension (no pid file) — refusing to kill an unmanaged process. Stop it in its own terminal."}
    try:
        os.unlink(PID_FILE)
    except OSError:
        pass
    return {"ok": True, "running": False, "note": "bridge was not running"}


def do_status():
    pid = read_pid()
    return {"ok": True, "running": port_open(), "pid": pid,
            "managed": bool(pid and pid_alive(pid))}


def main():
    data = sys.stdin.buffer
    raw_len = data.read(4)
    if len(raw_len) < 4:
        return
    (length,) = struct.unpack("<I", raw_len)
    try:
        msg = json.loads(data.read(length).decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        msg = {}
    cmd = msg.get("cmd")
    try:
        if cmd == "start":
            resp = do_start()
        elif cmd == "stop":
            resp = do_stop()
        elif cmd == "status":
            resp = do_status()
        else:
            resp = {"ok": False, "error": f"unknown cmd '{cmd}'. Use start|stop|status."}
    except Exception as e:  # never leave the extension hanging
        resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    out = json.dumps(resp).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(out)) + out)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
