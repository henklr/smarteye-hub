#!/usr/bin/env bash
set -euo pipefail

PI=${SMARTEYE_PI:-smarteye@smarteye-hub.local}
REMOTE_DIR=${SMARTEYE_REMOTE_DIR:-/home/smarteye/smarteye-hub}

echo "Deploying to $PI:$REMOTE_DIR ..."

tar czf - --exclude='.git' --exclude='data' --exclude='secrets' . \
  | ssh "$PI" "mkdir -p $REMOTE_DIR && tar xzf - -C $REMOTE_DIR && cd $REMOTE_DIR && docker compose up --build -d"

echo "Done."
