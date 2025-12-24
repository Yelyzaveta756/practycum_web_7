#!/bin/sh
set -e

CONTAINER_NAME=practycum-web-7

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker and retry." >&2
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  echo "Container ${CONTAINER_NAME} removed."
else
  echo "Container ${CONTAINER_NAME} is not running."
fi
