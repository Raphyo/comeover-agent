#!/bin/sh
# A display for the headed browser when the VM has none, then the bot. $PORT is injected by Maritime.
set -e
if [ -z "$DISPLAY" ]; then
  Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
  export DISPLAY=:99
fi
export BROWSER_EXE="$(find /opt/ms-playwright -type f -name chrome -path '*chrome-linux*' | head -1)"
mkdir -p /data
exec node bot.mjs
