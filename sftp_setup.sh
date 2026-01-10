#!/usr/bin/env bash
set -euo pipefail

log()  { echo -e "\033[1;32m[sftp_setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m  $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

# Where your uploads should land on the host
APP_DIR="${APP_DIR:-$HOME/sei-raspi}"
UPLOAD_DIR="${UPLOAD_DIR:-$APP_DIR/uploads}"

# Chroot root for SFTP (must be root-owned and not writable)
CHROOT_DIR="${CHROOT_DIR:-$APP_DIR/sftp-root}"
CHROOT_UPLOAD_DIR="$CHROOT_DIR/uploads"

# Use /dev/tty for reliable prompting even if script is piped
TTY="/dev/tty"

require_tty() {
  if [[ ! -t 0 && ! -t 1 ]]; then
    err "No interactive terminal detected. Run this script directly in a terminal."
    err "Example: bash $APP_DIR/sftp_setup.sh"
    exit 1
  fi
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

log "Installing OpenSSH server (for SFTP)..."
sudo apt update
sudo apt install -y openssh-server
sudo systemctl enable --now ssh

echo > "$TTY"
log "SFTP account setup (interactive)"
SFTP_USER="${SFTP_USER:-$(prompt_user "Enter SFTP username")}"
SFTP_PASSWORD="$(prompt_password)"
SFTP_GROUP="${SFTP_GROUP:-$SFTP_USER}"

log "Using SFTP user: $SFTP_USER"
log "Uploads will go to: $UPLOAD_DIR"
log "Chroot root: $CHROOT_DIR"

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

# Set password reliably (avoid passwd)
log "Setting password for $SFTP_USER..."
echo "$SFTP_USER:$SFTP_PASSWORD" | sudo chpasswd

# Ensure directories exist
log "Creating upload directories..."
sudo mkdir -p "$UPLOAD_DIR"
sudo mkdir -p "$CHROOT_DIR"
sudo mkdir -p "$CHROOT_UPLOAD_DIR"

# Ensure parent dirs are not group/world writable (required for ChrootDirectory)
log "Ensuring chroot path components are not group/world-writable..."
sudo chmod go-w "$HOME"   || true
sudo chmod go-w "$APP_DIR" || true
sudo chmod go-w "$CHROOT_DIR" || true

# Chroot directory must be root-owned and not writable by anyone but root
log "Fixing chroot directory permissions (OpenSSH requirement)..."
sudo chown root:root "$CHROOT_DIR"
sudo chmod 755 "$CHROOT_DIR"

# Upload dir must be writable by SFTP user
log "Setting upload dir ownership..."
sudo chown "$SFTP_USER:$SFTP_GROUP" "$UPLOAD_DIR"
sudo chmod 755 "$UPLOAD_DIR"

# Bind-mount host uploads folder into chroot so the user sees /uploads
log "Bind-mounting $UPLOAD_DIR -> $CHROOT_UPLOAD_DIR ..."
if ! mountpoint -q "$CHROOT_UPLOAD_DIR"; then
  sudo mount --bind "$UPLOAD_DIR" "$CHROOT_UPLOAD_DIR"
fi

# Persist bind mount
FSTAB_LINE="$UPLOAD_DIR $CHROOT_UPLOAD_DIR none bind 0 0"
if ! grep -qF "$FSTAB_LINE" /etc/fstab; then
  echo "$FSTAB_LINE" | sudo tee -a /etc/fstab >/dev/null
  log "Persisted bind mount in /etc/fstab"
fi

# Write sshd config snippet
SSHD_SNIPPET="/etc/ssh/sshd_config.d/sei-sftp.conf"
log "Writing SSHD SFTP config snippet: $SSHD_SNIPPET"
sudo tee "$SSHD_SNIPPET" >/dev/null <<EOF
# SFTP-only config for $SFTP_USER
Match User $SFTP_USER
    ChrootDirectory $CHROOT_DIR
    ForceCommand internal-sftp
    X11Forwarding no
    AllowTcpForwarding no
    PermitTunnel no
EOF

log "Validating sshd config..."
sudo sshd -t

log "Chroot path permission check:"
sudo namei -l "$CHROOT_DIR"

log "Restarting SSH service..."
sudo systemctl restart ssh

echo > "$TTY"
log "✅ SFTP setup complete!"
log "Login: $SFTP_USER"
log "SFTP root (chroot): /"
log "Upload path inside SFTP: /uploads"
log "Host upload path: $UPLOAD_DIR"
log "Connect with: sftp $SFTP_USER@<pi-ip>"
