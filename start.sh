#!/bin/sh
set -eu

IMAGE_NAME=practycum-web-7
CONTAINER_NAME=practycum-web-7
HOST_ADDR=${HOST:-0.0.0.0}
PORT=${PORT:-3000}
APP_TZ=${APP_TZ:-Europe/Kyiv}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker and retry." >&2
  exit 1
fi

docker build -t "${IMAGE_NAME}" .

if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
fi

docker run -d \
  --name "${CONTAINER_NAME}" \
  -p "${PORT}:3000" \
  -e PORT=3000 \
  -e HOST="${HOST_ADDR}" \
  -e APP_TZ="${APP_TZ}" \
  "${IMAGE_NAME}"

echo "App is running at http://localhost:${PORT}"
