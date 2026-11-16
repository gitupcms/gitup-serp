#!/bin/sh
# Start a virtual display the size of a common desktop, then run the command.
set -e

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &

# Wait for the display socket rather than sleeping a fixed time.
i=0
while [ ! -e /tmp/.X11-unix/X99 ] && [ "$i" -lt 100 ]; do
    sleep 0.1
    i=$((i + 1))
done
if [ ! -e /tmp/.X11-unix/X99 ]; then
    echo "Xvfb did not start:" >&2
    cat /tmp/xvfb.log >&2
    exit 1
fi
export DISPLAY=:99

# `docker run IMAGE cli search "x"`, `mcp`, `egress:up` map to the npm scripts.
# -s keeps npm's banner off stdout (mcp speaks JSON on it).
case "$1" in
    cli | mcp | egress:*)
        script="$1"
        shift
        exec npm run -s "$script" -- "$@"
        ;;
esac

exec "$@"
