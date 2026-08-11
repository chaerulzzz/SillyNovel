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

# --- Gateway-drift preflight ----------------------------------------------
# whitelist in the deployed config hardcodes this network's gateway IP (see
# container/config.yaml). Apple Container's gateway isn't guaranteed to never
# change, so fail loudly here instead of silently starting an unreachable
# server. Docker-runtime deployments rely on whitelistDockerHosts instead, so
# this check only applies to the Apple `container` runtime.
if [[ "$CONTAINER_RUNTIME" == "container" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required for the gateway preflight check." >&2
    exit 1
  fi
  ACTUAL_GATEWAY="$(container network inspect default 2>/dev/null | jq -r '.[0].status.ipv4Gateway // empty')"
  if [[ -z "$ACTUAL_GATEWAY" ]]; then
    echo "ERROR: Could not determine the Apple Container 'default' network gateway." >&2
    echo "Run 'container network inspect default' manually to diagnose." >&2
    exit 1
  fi
  if ! grep -qF "$ACTUAL_GATEWAY" "$ST_STATE/config/config.yaml"; then
    echo "ERROR: Configured whitelist does not contain the current gateway IP." >&2
    echo "  Deployed config: $ST_STATE/config/config.yaml" >&2
    echo "  Actual gateway (container network inspect default): $ACTUAL_GATEWAY" >&2
    echo "Update the 'whitelist:' entry in that file to match, then re-run." >&2
    exit 1
  fi
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
  --env "PUID=$(id -u)" \
  --env "PGID=$(id -g)" \
  --volume "$ST_STATE/config:$APP_DIR/config" \
  --volume "$ST_STATE/data:$APP_DIR/data" \
  --volume "$ST_STATE/backups:$APP_DIR/backups" \
  --volume "$REPO_ROOT/plugin:$APP_DIR/plugins/sillynovel" \
  --volume "$REPO_ROOT/extension:$APP_DIR/public/scripts/extensions/third-party/sillynovel-writing" \
  "$IMAGE"
