#!/usr/bin/env bash
# Connect Openly — one-time native host install (enables Start/Stop buttons).
# Run once:  bash connect-openly/native-host/install_host.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST_PY="$HERE/connect_openly_host.py"
DEST="$HOME/.mozilla/native-messaging-hosts"

mkdir -p "$DEST"
chmod +x "$HOST_PY"
sed "s|__HOST_PATH__|$HOST_PY|" "$HERE/connect_openly.json.template" > "$DEST/connect_openly.json"

echo "installed -> $DEST/connect_openly.json"
echo "host      -> $HOST_PY"
echo "--- self-test (ask the host for status, exactly like Firefox will) ---"
python3 - "$HOST_PY" <<'EOF'
import json, struct, subprocess, sys
host = sys.argv[1]
msg = json.dumps({"cmd": "status"}).encode()
p = subprocess.run([host], input=struct.pack("<I", len(msg)) + msg,
                   capture_output=True, timeout=15)
(length,) = struct.unpack("<I", p.stdout[:4])
print("host replied:", json.loads(p.stdout[4:4 + length]))
EOF
echo "OK. Reload the extension in about:debugging, then use its Start/Stop buttons."
