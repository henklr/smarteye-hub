#!/usr/bin/env bash
set -euo pipefail

log()  { echo -e "\033[1;32m[sftp_setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m  $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

# Defaults (override via env vars)
SFTP_USER="${SFTP_USER:-sei-sftp}"
SFTP_GROUP="${SFTP_GROUP:-sei-sftp}"
CHROOT_DIR="${CHROOT_DIR:-$HOME/sei-raspi}"             # must be root-owned
UPLOAD_DIR="${UPLOAD_DIR:-$HOME/sei-raspi/uploads}"     # writable by sftp user

log "Setting up SFTP-only user: $SFTP_USER"
log "Chroot directory: $CHROOT_DIR"
log "Upload directory: $UPLOAD_DIR"

# Ensure openssh-server installed
log "Installing OpenSSH server..."
sudo apt update
sudo apt install -y openssh-server

log "Enabling SSH service..."
sudo systemctl enable --now ssh

# Create group if needed
if ! getent group "$SFTP_GROUP" >/dev/null; then
  log "Creating group: $SFTP_GROUP"
  sudo groupadd "$SFTP_GROUP"
fi

# Create user if needed
if ! id "$SFTP_USER" >/dev/null 2>&1; then
  log "Creating SFTP user: $SFTP_USER (no shell access)"
  sudo useradd -m -g "$SFTP_GROUP" -s /usr/sbin/nologin "$SFTP_USER"
  warn "Set a password for $SFTP_USER now:"
  sudo passwd "$SFTP_USER"
else
  log "User $SFTP_USER already exists. Skipping creation."
fi

# Ensure chroot dir exists
log "Ensuring chroot and upload directories exist..."
sudo mkdir -p "$CHROOT_DIR"
sudo mkdir -p "$UPLOAD_DIR"

# IMPORTANT: Chroot directory must be owned by root and not writable by others
log "Fixing chroot permissions (required by OpenSSH)..."
sudo chown root:root "$CHROOT_DIR"
sudo chmod 755 "$CHROOT_DIR"

# Upload dir must be writable by SFTP user
log "Setting upload dir ownership + permissions..."
sudo chown "$SFTP_USER":"$SFTP_GROUP" "$UPLOAD_DIR"
sudo chmod 755 "$UPLOAD_DIR"

# Create an SSHD config snippet (preferred over editing main file)
SSHD_SNIPPET="/etc/ssh/sshd_config.d/sei-sftp.conf"

log "Writing SSHD SFTP config snippet: $SSHD_SNIPPET"
sudo tee "$SSHD_SNIPPET" >/dev/null <<EOF
# SFTP-only setup for $SFTP_USER
Match User $SFTP_USER
    ChrootDirectory $CHROOT_DIR
    ForceCommand internal-sftp
    X11Forwarding no
    AllowTcpForwarding no
    PermitTunnel no
EOF

log "Checking sshd config..."
sudo sshd -t

log "Restarting SSH service..."
sudo systemctl restart ssh

log "SFTP setup complete!"
log "SFTP user: $SFTP_USER"
log "Uploads directory (inside chroot): /uploads"
log "Connect like: sftp $SFTP_USER@<pi-ip>"
