#!/usr/bin/env bash
set -euo pipefail

log()  { echo -e "\033[1;32m[sftp_setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m  $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

TTY="/dev/tty"

require_tty() {
  if [[ ! -e "$TTY" ]]; then
    err "/dev/tty not available; cannot prompt interactively."
    exit 1
  fi
}

prompt_user() {
  local prompt="$1"
  local v=""
  while [[ -z "$v" ]]; do
    echo -n "$prompt: " > "$TTY"
    read -r v < "$TTY" || true
    v="${v//[$'\r\n']}"
  done
  echo "$v"
}

prompt_password() {
  local p1="" p2=""
  while true; do
    echo -n "SFTP password: " > "$TTY"
    stty -echo < "$TTY"
    read -r p1 < "$TTY" || true
    stty echo < "$TTY"
    echo > "$TTY"

    echo -n "Retype password: " > "$TTY"
    stty -echo < "$TTY"
    read -r p2 < "$TTY" || true
    stty echo < "$TTY"
    echo > "$TTY"

    if [[ -z "$p1" ]]; then
      warn "Password cannot be empty."
    elif [[ "$p1" != "$p2" ]]; then
      warn "Passwords do not match. Try again."
    else
      echo "$p1"
      return 0
    fi
  done
}

require_tty

# Host-side uploads directory (Docker will use this)
APP_DIR="${APP_DIR:-$HOME/sei-raspi}"
UPLOAD_DIR="${UPLOAD_DIR:-$APP_DIR/uploads}"

# Chroot is system-owned (avoids /home permission issues)
CHROOT_DIR="${CHROOT_DIR:-/srv/sei-sftp/chroot}"
CHROOT_UPLOAD_DIR="$CHROOT_DIR/uploads"

# Group-based match avoids overwriting config per user
SFTP_GROUP="${SFTP_GROUP:-sftpusers}"
SSHD_SNIPPET="${SSHD_SNIPPET:-/etc/ssh/sshd_config.d/90-sftp-chroot.conf}"

log "Installing OpenSSH server (for SFTP)..."
sudo apt update
sudo apt install -y openssh-server
sudo systemctl enable --now ssh

echo > "$TTY"
log "SFTP account setup (interactive)"
SFTP_USER="${SFTP_USER:-$(prompt_user "Enter SFTP username")}"
SFTP_PASSWORD="$(prompt_password)"

log "Using SFTP user: $SFTP_USER"
log "Uploads will go to (host): $UPLOAD_DIR"
log "Chroot root: $CHROOT_DIR"
log "SFTP group: $SFTP_GROUP"

# Ensure uploads dir exists
log "Ensuring host upload directory exists..."
sudo mkdir -p "$UPLOAD_DIR"

# Ensure chroot exists (must be root-owned and not writable)
log "Ensuring chroot directory exists..."
sudo mkdir -p "$CHROOT_UPLOAD_DIR"
sudo chown root:root "$CHROOT_DIR"
sudo chmod 755 "$CHROOT_DIR"

# Bind-mount uploads into chroot (/uploads inside SFTP)
log "Bind-mounting uploads into chroot..."
if ! mountpoint -q "$CHROOT_UPLOAD_DIR"; then
  sudo mount --bind "$UPLOAD_DIR" "$CHROOT_UPLOAD_DIR"
fi

# Persist bind mount
FSTAB_LINE="$UPLOAD_DIR $CHROOT_UPLOAD_DIR none bind 0 0"
if ! grep -qF "$FSTAB_LINE" /etc/fstab; then
  echo "$FSTAB_LINE" | sudo tee -a /etc/fstab >/dev/null
  log "Persisted bind mount in /etc/fstab"
fi

# Create group if needed
if ! getent group "$SFTP_GROUP" >/dev/null; then
  log "Creating group: $SFTP_GROUP"
  sudo groupadd "$SFTP_GROUP"
fi

# Create user if needed
if ! id "$SFTP_USER" >/dev/null 2>&1; then
  log "Creating SFTP-only user: $SFTP_USER"
  sudo useradd -m -g "$SFTP_GROUP" -s /usr/sbin/nologin "$SFTP_USER"
else
  log "User $SFTP_USER already exists."
  sudo usermod -s /usr/sbin/nologin "$SFTP_USER"
fi

# Ensure user is in group (important if user existed already)
sudo usermod -aG "$SFTP_GROUP" "$SFTP_USER"

# Set password reliably
log "Setting password for $SFTP_USER..."
echo "$SFTP_USER:$SFTP_PASSWORD" | sudo chpasswd

# Host upload dir should be writable by SFTP user
log "Setting upload dir ownership..."
sudo chown "$SFTP_USER:$SFTP_GROUP" "$UPLOAD_DIR"
sudo chmod 755 "$UPLOAD_DIR"

# IMPORTANT: remove any old per-user snippets that force /home/... chroot
# (This prevents regression / "Connection reset" issues)
log "Removing legacy SFTP sshd snippets (if any)..."
sudo rm -f /etc/ssh/sshd_config.d/sei-sftp.conf
sudo rm -f /etc/ssh/sshd_config.d/sei-sftp-*.conf

# Write group-based sshd config (only once)
if [[ ! -f "$SSHD_SNIPPET" ]]; then
  log "Writing SSHD SFTP group config snippet: $SSHD_SNIPPET"
  sudo tee "$SSHD_SNIPPET" >/dev/null <<EOF
Match Group $SFTP_GROUP
    ChrootDirectory $CHROOT_DIR
    ForceCommand internal-sftp
    X11Forwarding no
    AllowTcpForwarding no
    PermitTunnel no
EOF
else
  log "SSHD snippet already exists: $SSHD_SNIPPET (not overwriting)"
fi

log "Validating sshd config..."
sudo sshd -t

log "Restarting SSH service..."
sudo systemctl restart ssh

# Verify effective config for this user
log "Verifying effective config for user $SFTP_USER..."
sudo sshd -T -C user="$SFTP_USER",host=localhost,addr=127.0.0.1 | grep -i chroot || true

echo > "$TTY"
log "✅ SFTP setup complete!"
log "Login: $SFTP_USER"
log "SFTP root (chroot): /"
log "Upload path inside SFTP: /uploads"
log "Host upload path: $UPLOAD_DIR"
log "Connect with: sftp $SFTP_USER@<pi-ip>"
