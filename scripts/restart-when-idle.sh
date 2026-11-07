#!/bin/bash
# Restart the daemon once no session has been mid-turn for a while, so a restart that loads new
# daemon code never lands on a turn the phone is waiting on (each phone session is a child of the
# daemon, and a restart kills it). Runs detached; give up after MAX_WAIT seconds.
#
#   scripts/restart-when-idle.sh [label]     (default: the installed *vibemachine.daemon agent)
set -u
DB="${DATA_DIR:-$HOME/Library/Application Support/VibeMachine}/vibemachine.sqlite"
LABEL="${1:-$(launchctl list | awk '/vibemachine\.daemon$/{print $3; exit}')}"
QUIET="${QUIET:-30}"
MAX_WAIT="${MAX_WAIT:-21600}"
[ -n "$LABEL" ] || { echo "no vibemachine daemon agent loaded"; exit 1; }
# Busy: a session marked mid-turn, or any stream line in the last QUIET seconds. A turn the session
# starts itself (a background job's notification) marks it running since 2026-10-28; before that it
# didn't, and a restart on 2026-10-27 killed one mid-upload, so the stream check stays as a second
# guard. Neither sees an upload running quietly in the background between turns: don't start this
# while one of yours is still going.
busy() {
  [ "$(sqlite3 -readonly "$DB" "SELECT count(*) FROM sessions WHERE status IN ('starting','running','waiting')" 2>/dev/null || echo 1)" != "0" ] && return 0
  [ "$(sqlite3 -readonly "$DB" "SELECT count(*) FROM events WHERE ts > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-$QUIET seconds')" 2>/dev/null || echo 1)" != "0" ]
}
start=$(date +%s); quiet=0
while :; do
  if busy; then quiet=0; else quiet=$((quiet + 5)); fi
  [ "$quiet" -ge "$QUIET" ] && break
  [ $(( $(date +%s) - start )) -ge "$MAX_WAIT" ] && { echo "$(date +%T) still busy after ${MAX_WAIT}s; not restarting"; exit 1; }
  sleep 5
done
echo "$(date +%T) idle for ${QUIET}s: restarting $LABEL"
exec /bin/launchctl kickstart -k "gui/$(id -u)/$LABEL"
