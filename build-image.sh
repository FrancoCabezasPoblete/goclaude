#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROOTFS_IMAGE="goclaude-rootfs:trixie"
GONDOLIN_IMAGE="${IMAGE:-claude-code:latest}"

docker build \
  --pull \
  --platform linux/amd64 \
  --tag "$ROOTFS_IMAGE" \
  "$DIR"

gondolin build \
  --config "$DIR/claude-config.json" \
  --tag "$GONDOLIN_IMAGE"

gondolin exec \
  --image "$GONDOLIN_IMAGE" \
  -- sh -lc '
    claude --version
    node --version
    pnpm --version
  '
