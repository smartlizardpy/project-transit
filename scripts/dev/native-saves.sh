#!/bin/sh
# Save round trip in the real desktop app, across three launches (works with the screen locked):
#   1. write   - new company, build, save, play on, close the window (close hook autosaves)
#   2. reopen  - load that autosave, play on, quit the way Cmd+Q does (quit hook autosaves)
#   3. cleanup - load that autosave, delete the test company's saves
# Each launch writes <out>/<step>/save-check.json. Build first: pnpm tauri build --bundles app
set -u
OUT="${1:-native-saves}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
APP="${APP:-src-tauri/target/release/bundle/macos/Project Transit.app}"
for STEP in write reopen cleanup; do
  mkdir -p "$OUT/$STEP"
  rm -f "$OUT/$STEP/save-check.json"
  open -n -W --env PT_DIAG_DIR="$OUT/$STEP" --env PT_DIAG_SAVE=$STEP "$APP" &
  PID=$!
  i=0
  while kill -0 $PID 2>/dev/null && [ $i -lt 120 ]; do sleep 1; i=$((i + 1)); done
  if kill -0 $PID 2>/dev/null; then
    echo "== $STEP: app did not exit within 120 s"
    pkill -f "Project Transit.app/Contents/MacOS" ; kill $PID 2>/dev/null
  else
    echo "== $STEP: app exited after ${i}s"
  fi
  cat "$OUT/$STEP/save-check.json" 2>/dev/null || echo "(no report)"
  echo
done
