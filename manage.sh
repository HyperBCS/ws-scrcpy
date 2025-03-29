#!/bin/bash

set -e

case "$1" in
  build)
    docker buildx build --load -f Dockerfile -t ws-scrcpy:latest .
    ;;
  build-dev)
    docker buildx build --load -f Dockerfile.dev -t ws-scrcpy-dev:latest .
    ;;
  start)
    docker compose up -d ws-scrcpy
    echo "Container started. Attaching logs..."
    docker logs -f ws-scrcpy
    ;;
  stop)
    docker compose down
    ;;
  dev)
    docker compose up ws-scrcpy-dev
    ;;
  *)
    echo "Usage: $0 {build|build-dev|start|stop|dev}"
    exit 1
esac
