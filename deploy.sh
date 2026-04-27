#!/usr/bin/env bash
set -euo pipefail

PI=${SMARTEYE_PI:-smarteye@smarteye-hub.local}
REMOTE_DIR=${SMARTEYE_REMOTE_DIR:-/home/smarteye/smarteye-hub}

KEY="$HOME/.ssh/id_ed25519"
if [[ ! -f "$KEY" ]]; then
  echo "No SSH key found, generating $KEY ..."
  ssh-keygen -t ed25519 -N "" -f "$KEY"
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$PI" true 2>/dev/null; then
  echo "Installing SSH key on $PI (enter password one last time) ..."
  cat "$KEY.pub" | ssh "$PI" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
fi

echo "Deploying to $PI:$REMOTE_DIR ..."

tar czf - --exclude='.git' --exclude='data' --exclude='secrets' . \
  | ssh "$PI" "mkdir -p $REMOTE_DIR && tar xzf - -C $REMOTE_DIR && cd $REMOTE_DIR && docker compose up --build -d"

echo "Done."
