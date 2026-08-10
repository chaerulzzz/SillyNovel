#!/usr/bin/env bash
#
# SillyNovel — run stock SillyTavern with our extension and plugin mounted.
#
# Target runtime: Apple Container on macOS (`container`). Set
# CONTAINER_RUNTIME=docker to use a Docker-compatible runtime instead.
#
# Usage:  ./container/run.sh
#
set -euo pipefail

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

# --- Pinned image ---------------------------------------------------------
# NEVER run :latest — an upstream change can break an extension API or plugin
# assumption overnight. Phase 1 resolves a release tag to a digest and records
# BOTH here and in the README; upgrading is then a deliberate, tested step.
IMAGE_REPO="ghcr.io/sillytavern/sillytavern"
IMAGE_TAG="1.18.0"
# Immutable multi-platform index. On Apple Silicon it resolves to the
# linux/arm64 manifest documented in README.md.
IMAGE_DIGEST="sha256:7b30a1698b605d01dbd01a20459600c035f0d2c866912b69d7eee98065dcedd3"

if [[ -z "$IMAGE_TAG" || ! "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: The SillyTavern image tag or digest is invalid." >&2
  exit 1
fi

IMAGE="${IMAGE_REPO}:${IMAGE_TAG}@${IMAGE_DIGEST}"
CONTAINER_NAME="sillynovel"

if ! command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1; then
  echo "ERROR: Container runtime '$CONTAINER_RUNTIME' was not found." >&2
  exit 1
fi

# Never replace an existing container implicitly. Its mounted state may contain
# user prose or plaintext API credentials.
if "$CONTAINER_RUNTIME" inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "ERROR: Container '$CONTAINER_NAME' already exists." >&2
  echo "Inspect, start, stop, or delete it explicitly before recreating it." >&2
  exit 1
fi

# --- Paths ----------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Persistent SillyTavern state. Kept OUTSIDE the repo: it holds user data and
# secrets.json (plaintext API keys) and must never be committed.
ST_STATE="${SILLYNOVEL_STATE:-$HOME/.sillynovel}"

mkdir -p "$ST_STATE"/{config,data,backups}
if [[ ! -e "$ST_STATE/config/config.yaml" ]]; then
  cp "$REPO_ROOT/container/config.yaml" "$ST_STATE/config/config.yaml"
  echo "Created initial config: $ST_STATE/config/config.yaml"
fi

APP_DIR="/home/node/app"

# --- Run ------------------------------------------------------------------
# 🔒 Published on 127.0.0.1 ONLY — never 0.0.0.0. That is the difference
# between a loopback service and one exposed to the whole LAN.
#
# extension/ and plugin/ are mounted straight from the working tree so edits are
# live. Note the asymmetry: extension changes need only a browser reload, while
# plugin changes require restarting this container.
echo "Starting SillyTavern ${IMAGE_TAG}"
echo "Pinned digest: ${IMAGE_DIGEST}"
echo "Persistent state: ${ST_STATE}"

exec "$CONTAINER_RUNTIME" run \
  --detach \
  --name "$CONTAINER_NAME" \
  --publish 127.0.0.1:8000:8000 \
  --volume "$ST_STATE/config:$APP_DIR/config" \
  --volume "$ST_STATE/data:$APP_DIR/data" \
  --volume "$ST_STATE/backups:$APP_DIR/backups" \
  --volume "$REPO_ROOT/plugin:$APP_DIR/plugins/sillynovel" \
  --volume "$REPO_ROOT/extension:$APP_DIR/public/scripts/extensions/third-party/sillynovel-writing" \
  "$IMAGE"
