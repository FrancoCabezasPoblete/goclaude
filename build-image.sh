#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Backend: "alpine" (default) builds the rootfs natively with gondolin,
# "docker" builds a rootfs image with Docker and consumes it via OCI.
BACKEND="alpine"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--alpine|--docker] [--help]

Build the goclaude sandbox image.

Backends:
  --alpine   Native gondolin rootfs on Alpine (default).
  --docker   Build the rootfs with Docker and consume it via OCI.

Environment:
  IMAGE      Tag of the final gondolin image (default: claude-code:latest)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --alpine|alpine) BACKEND="alpine" ;;
    --docker|docker) BACKEND="docker" ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

GONDOLIN_IMAGE="${IMAGE:-claude-code:latest}"

case "$BACKEND" in
  alpine)
    CONFIG="$DIR/alpine/claude-config.json"
    ;;
  docker)
    CONFIG="$DIR/docker/claude-config.json"
    # Single source of truth: the OCI image referenced by the build config.
    ROOTFS_IMAGE="$(CONFIG="$CONFIG" node -p \
      "JSON.parse(require('fs').readFileSync(process.env.CONFIG, 'utf8')).oci.image")"

    docker build \
      -f "$DIR/docker/Dockerfile" \
      --pull \
      --platform linux/amd64 \
      --tag "$ROOTFS_IMAGE" \
      "$DIR"
    ;;
esac

gondolin build \
  --config "$CONFIG" \
  --tag "$GONDOLIN_IMAGE"

gondolin exec \
  --image "$GONDOLIN_IMAGE" \
  -- sh -lc '
    claude --version
    node --version
    pnpm --version
  '
