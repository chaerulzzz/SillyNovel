#!/usr/bin/env bash
#
# SillyNovel — run stock SillyTavern with our extension and plugin mounted.
#
# Target runtime: Apple Container on macOS (`container`), not Docker.
# The CLI is broadly docker-like, but flag support differs — Phase 1 verifies
# this script actually runs before anything depends on it.
#
# Usage:  ./container/run.sh
#
set -euo pipefail

# --- Pinned image ---------------------------------------------------------
# NEVER run :latest — an upstream change can break an extension API or plugin
# assumption overnight. Phase 1 resolves a release tag to a digest and records
# BOTH here and in the README; upgrading is then a deliberate, tested step.
IMAGE_REPO="ghcr.io/sillytavern/sillytavern"
IMAGE_TAG=""      # e.g. 1.12.x  — set in Phase 1
IMAGE_DIGEST=""   # e.g. sha256:… — set in Phase 1

if [[ -z "$IMAGE_DIGEST" ]]; then
  echo "ERROR: IMAGE_DIGEST is unset." >&2
  echo "Resolve the pinned digest first (docs/PLAN.md, Phase 1):" >&2
  echo "  container image pull ${IMAGE_REPO}:<tag>" >&2
  echo "  container image inspect ${IMAGE_REPO}:<tag>   # read the digest" >&2
  exit 1
fi

IMAGE="${IMAGE_REPO}@${IMAGE_DIGEST}"

# --- Paths ----------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Persistent SillyTavern state. Kept OUTSIDE the repo: it holds user data and
# secrets.json (plaintext API keys) and must never be committed.
ST_STATE="${SILLYNOVEL_STATE:-$HOME/.sillynovel}"

mkdir -p "$ST_STATE"/{config,data,backups}
cp -n "$REPO_ROOT/container/config.yaml" "$ST_STATE/config/config.yaml" 2>/dev/null || true

CONTAINER_NAME="sillynovel"
APP_DIR="/home/node/app"

# --- Run ------------------------------------------------------------------
# 🔒 Published on 127.0.0.1 ONLY — never 0.0.0.0. That is the difference
# between a loopback service and one exposed to the whole LAN.
#
# extension/ and plugin/ are mounted straight from the working tree so edits are
# live. Note the asymmetry: extension changes need only a browser reload, while
# plugin changes require restarting this container.
exec container run \
  --detach \
  --name "$CONTAINER_NAME" \
  --publish 127.0.0.1:8000:8000 \
  --volume "$ST_STATE/config:$APP_DIR/config" \
  --volume "$ST_STATE/data:$APP_DIR/data" \
  --volume "$ST_STATE/backups:$APP_DIR/backups" \
  --volume "$REPO_ROOT/plugin:$APP_DIR/plugins/sillynovel" \
  --volume "$REPO_ROOT/extension:$APP_DIR/public/scripts/extensions/third-party/sillynovel-writing" \
  "$IMAGE"
