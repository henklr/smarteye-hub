#!/usr/bin/env bash
set -euo pipefail

PI=${SMARTEYE_PI:-smarteye@smarteye-hub.local}
REMOTE_DIR=${SMARTEYE_REMOTE_DIR:-/home/smarteye/smarteye-hub}
KEY=${SMARTEYE_SSH_KEY:-"$HOME/.ssh/smarteye_hub_ed25519"}
SSH_OPTS=(
  -i "$KEY"
  -o IdentitiesOnly=yes
  -o ConnectTimeout=10
  -o ConnectionAttempts=1
  -o ServerAliveInterval=5
  -o ServerAliveCountMax=2
)

if [[ "${SMARTEYE_SSH_DEBUG:-}" == "1" ]]; then
  SSH_OPTS+=(-v)
fi

if [[ ! -f "$KEY" ]]; then
  echo "No SSH key found, generating $KEY ..."
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  ssh-keygen -t ed25519 -N "" -f "$KEY" -C "smarteye-hub deploy"
fi

if ! ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$PI" true 2>/dev/null; then
  echo "Installing SSH key on $PI (enter password one last time) ..."
  ssh "${SSH_OPTS[@]}" "$PI" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" < "$KEY.pub"
fi

echo "Deploying to $PI:$REMOTE_DIR ..."

tar czf - --exclude='.git' --exclude='data' --exclude='secrets' . \
  | ssh "${SSH_OPTS[@]}" "$PI" "mkdir -p $REMOTE_DIR && tar xzf - -C $REMOTE_DIR && cd $REMOTE_DIR && docker compose up --build -d"

echo "Done."
