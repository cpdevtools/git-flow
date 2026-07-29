#!/bin/sh
# Supervised restart for a node (npm + pm2) deploy. Output is NEVER discarded:
# the detached supervisor appends everything — plus the terminal EXIT line — to
# the release's deploy.log, the same file the deploy service streams/tails, so a
# self-update's restart + health verification survive the restart and stay
# visible in the workflow via the reconnect mechanism.
#
# NOTE: This file is shipped verbatim into every npm.node deploy bundle (copied
# by generateDeployYml in deploy-methods.ts). Keep it POSIX sh — it runs under
# dash on the deploy target. Run `shellcheck` on it before releasing.
set -u

VERSION="${1:-}"
NPM_PREFIX="${GITFLOW_NPM_PREFIX:-$HOME/.npm-global}"
# Resolve the pm2 executable robustly. Prefer an explicit path (phase 1 passes
# the resolved path to the detached phase 2 via GITFLOW_PM2), then PATH, then
# common install locations — so the detached restart never dies with
# "pm2: not found" under a minimal PATH or an unexpected install prefix.
PM2="${GITFLOW_PM2:-}"
if [ -z "$PM2" ]; then
  PM2=$(command -v pm2 2>/dev/null || true)
fi
if [ -z "$PM2" ]; then
  for _c in "$NPM_PREFIX/bin/pm2" "$HOME/.npm-global/bin/pm2" "$HOME/.local/share/pnpm/pm2" /usr/local/bin/pm2 /usr/bin/pm2; do
    if [ -x "$_c" ]; then PM2="$_c"; break; fi
  done
fi
PORT="${PORT:-3700}"
# The reconnectable, release_id-keyed log. Defaults to ./deploy.log because the
# deploy command runs with cwd = the release working dir (where the service also
# created deploy.log). GITFLOW_DEPLOY_LOG overrides it.
DEPLOY_LOG="${GITFLOW_DEPLOY_LOG:-$PWD/deploy.log}"

# Phase 1 (attached): launch the detached supervisor, then return promptly so the
# deploy command exits and the service can hand off. This phase's stdout is
# captured by the service and already lands in deploy.log.
if [ "${GITFLOW_RESTART_DETACHED:-}" != "1" ]; then
  echo "▸ Restart running in background (survives the restart); output continues in this log."
  GITFLOW_RESTART_DETACHED=1 GITFLOW_DEPLOY_LOG="$DEPLOY_LOG" GITFLOW_PM2="$PM2" setsid sh "$0" "$VERSION" >>"$DEPLOY_LOG" 2>&1 </dev/null &
  exit 0
fi

# Phase 2 (detached): restart + verify. stdout/stderr are appended to deploy.log
# (redirected by phase 1), and we append the terminal EXIT:<code> line here so
# the (restarted) service's tailer finalizes the deploy from the log.
echo "=== restart $(date -u +%FT%TZ) -> v${VERSION:-?} ==="

# Give the deploy's HTTP response / log stream a moment to flush and the service
# to record the handoff before we kill it.
sleep 3

# Final guard: if the resolved path isn't executable, try a bare PATH lookup,
# otherwise fail fast with a clear message and terminal EXIT so the tailer stops.
if [ -z "$PM2" ] || [ ! -x "$PM2" ]; then
  if command -v pm2 >/dev/null 2>&1; then
    PM2=pm2
  else
    echo "✗ pm2 executable not found (checked GITFLOW_PM2, PATH, $NPM_PREFIX/bin, ~/.local/share/pnpm, /usr/local/bin, /usr/bin)"
    echo "EXIT:127"
    exit 127
  fi
fi

# Restart by app name (reuses the running app's absolute script path) when it can
# be resolved from ecosystem.config.js; otherwise fall back to the config file.
APP=$(node -e "try{const c=require(process.cwd()+'/ecosystem.config.js');const a=((c&&c.apps)||(c&&c.default&&c.default.apps)||[])[0];process.stdout.write((a&&a.name)||'')}catch(e){}" 2>/dev/null)
if [ -n "$APP" ]; then
  echo "▸ pm2 restart $APP --update-env"
  "$PM2" restart "$APP" --update-env
else
  echo "▸ pm2 restart ecosystem.config.js --update-env"
  "$PM2" restart ecosystem.config.js --update-env
fi
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "✗ pm2 restart exited $rc"
  echo "EXIT:$rc"
  exit "$rc"
fi

echo "▸ Verifying /health on 127.0.0.1:$PORT ..."
code=""
got=""
i=0
while [ "$i" -lt 30 ]; do
  i=$((i + 1))
  sleep 2
  body=$(node -e "fetch('http://127.0.0.1:$PORT/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" 2>/dev/null) || { echo "  [$i] no response yet"; continue; }
  echo "  [$i] health: $body"
  got=$(printf '%s' "$body" | sed -n 's/.*"version"[": ]*"\([^"]*\)".*/\1/p')
  if [ -z "$got" ]; then
    echo "✓ Service healthy (no version reported by /health)."
    code=0
    break
  fi
  if [ "$got" = "$VERSION" ]; then
    echo "✓ Restart verified: now running v$got."
    code=0
    break
  fi
  echo "✗ Version mismatch: /health reports v$got, expected v$VERSION."
  code=1
  break
done

if [ -z "$code" ]; then
  echo "⚠ Restart issued but /health did not confirm within timeout."
  code=0
fi

echo "EXIT:$code"
exit "$code"
