#!/usr/bin/env bash
set -euo pipefail

log()  { echo -e "\033[1;32m[setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m  $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

APP_DIR="$HOME/sei-raspi"
REPO_URL="https://github.com/henklr/sei-raspi.git"
IMAGE_NAME="sei-raspi"
CONTAINER_NAME="sei-raspi"
PORT="8000"

log "Updating system..."
sudo apt update

log "Installing prerequisites..."
sudo apt install -y ca-certificates curl gnupg git

# Install Docker only if it isn't already installed
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found. Installing Docker..."

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  log "Adding Docker repository..."
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

  sudo apt update
  sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker is already installed. Skipping install."
fi

log "Enabling Docker to start on boot..."
sudo systemctl enable --now docker

# Add current user to docker group (won’t take effect until new login)
if ! groups "$USER" | grep -q "\bdocker\b"; then
  log "Adding user '$USER' to docker group..."
  sudo usermod -aG docker "$USER"
  warn "Docker group membership will apply AFTER you log out and log back in (or reboot)."
else
  log "User '$USER' is already in docker group."
fi

# Clone or update repo
if [ -d "$APP_DIR/.git" ]; then
  log "Repo already exists at $APP_DIR. Pulling latest changes..."
  git -C "$APP_DIR" pull
else
  log "Cloning repo into $APP_DIR..."
  git clone "$REPO_URL" "$APP_DIR"
fi

log "Building Docker image..."
sudo docker build -t "$IMAGE_NAME" "$APP_DIR"

# Stop old container if running
if sudo docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  log "Stopping and removing existing container..."
  sudo docker stop "$CONTAINER_NAME" >/dev/null || true
  sudo docker rm "$CONTAINER_NAME" >/dev/null || true
fi

log "Starting container on port $PORT..."
sudo docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "$PORT:$PORT" \
  "$IMAGE_NAME"

log "Done!"
log "Visit: http://$(hostname -I | awk '{print $1}'):$PORT/"
warn "If you want to run docker without sudo, log out and log back in (or reboot)."
