#!/usr/bin/env bash
set -euo pipefail

log()  { echo -e "\033[1;32m[setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m  $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

APP_DIR="$HOME/sei-raspi"
REPO_URL="https://github.com/henklr/sei-raspi.git"
IMAGE_NAME="sei-raspi"
CONTAINER_NAME="sei-raspi"
PORT="${PORT:-8000}"   # Allow override: PORT=1234 ./install.sh

# Determine if we should use sudo for docker
DOCKER="docker"
if ! groups "$USER" | grep -q "\bdocker\b"; then
  DOCKER="sudo docker"
fi

log "Updating system..."
sudo apt update

log "Installing prerequisites..."
sudo apt install -y ca-certificates curl gnupg git lsb-release

# Install Docker only if it isn't already installed
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found. Installing Docker..."

  OS_ID="$(. /etc/os-release && echo "$ID")"
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  ARCH="$(dpkg --print-architecture)"

  # Raspbian uses Debian repo
  if [[ "$OS_ID" == "raspbian" ]]; then
    DOCKER_DIST="debian"
  else
    DOCKER_DIST="$OS_ID"
  fi

  log "Detected OS: $OS_ID ($CODENAME), Arch: $ARCH"
  log "Setting Docker repo: $DOCKER_DIST"

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${DOCKER_DIST}/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  log "Adding Docker repository..."
  echo \
    "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DOCKER_DIST} \
    ${CODENAME} stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

  sudo apt update
  sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker is already installed. Skipping install."
fi

log "Enabling Docker to start on boot..."
sudo systemctl enable --now docker

log "Verifying Docker..."
if ! sudo docker run --rm hello-world >/dev/null 2>&1; then
  warn "Docker test failed. Try: sudo docker run hello-world"
else
  log "Docker OK."
fi

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

log "Building Docker image (this may take a while on Raspberry Pi)..."
$DOCKER build --pull -t "$IMAGE_NAME" "$APP_DIR"

# Stop old container if running
if $DOCKER ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  log "Stopping and removing existing container..."
  $DOCKER stop "$CONTAINER_NAME" >/dev/null || true
  $DOCKER rm "$CONTAINER_NAME" >/dev/null || true
fi

log "Starting container on port $PORT..."
$DOCKER run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "$PORT:$PORT" \
  "$IMAGE_NAME"

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-127.0.0.1}"

log "Done!"
log "Visit: http://${HOST_IP}:${PORT}/"
warn "If you want to run docker without sudo, log out and log back in (or reboot)."
