#!/bin/bash
# Install (or reinstall) the daemon as a LaunchAgent on this Mac: `npm install`
# if needed, then `vm setup`, which writes the plist (reusing an existing
# *vibemachine.daemon label), starts the daemon, fronts it with Tailscale
# Serve when Tailscale is connected, and prints a pairing code for the phone.
# Run it again after pulling changes: it restarts the daemon.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Node 24 or newer is needed first (brew install node)."; exit 1; }
[ -d node_modules ] || npm install --no-fund --no-audit
# The LaunchAgent runs the JavaScript build; a fresh one after every pull.
npm run build --silent
exec ./bin/vibemachine setup "$@"
