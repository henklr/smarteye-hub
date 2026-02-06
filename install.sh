#!/usr/bin/env bash
set -euo pipefail

log()  { echo -e "\033[1;32m[setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m  $*"; }

APP_DIR="$HOME/sei-raspi"
REPO_URL="https://github.com/henklr/sei-raspi.git"
IMAGE_NAME="sei-raspi"
CONTAINER_NAME="sei-raspi"
PORT="${PORT:-8000}"

DOCKER="docker"
if ! groups "$USER" | grep -q "\bdocker\b"; then
  DOCKER="sudo docker"
fi

log "Updating system..."
sudo apt update

log "Installing prerequisites..."
sudo apt install -y ca-certificates curl gnupg git lsb-release

# Install Docker only if missing
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found. Installing Docker..."

  OS_ID="$(. /etc/os-release && echo "$ID")"
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  ARCH="$(dpkg --print-architecture)"

  if [[ "$OS_ID" == "raspbian" ]]; then
    DOCKER_DIST="debian"
  else
    DOCKER_DIST="$OS_ID"
  fi

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${DOCKER_DIST}/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

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

log "Ensuring scripts are executable..."
chmod +x "$APP_DIR/rebuild" "$APP_DIR/start" || true

log "Building + starting..."
"$APP_DIR/rebuild"

# Helper symlink: rebuild -> ~/bin/rebuild
log "Installing helper script: rebuild (symlink to repo)..."
BIN_DIR="$HOME/bin"
mkdir -p "$BIN_DIR"

rm -f "$BIN_DIR/rebuild"
ln -s "$APP_DIR/rebuild" "$BIN_DIR/rebuild"

log "Ensuring $HOME/bin is on PATH..."
SHELL_RC=""
if [[ -n "${BASH_VERSION:-}" ]]; then
  SHELL_RC="$HOME/.bashrc"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  SHELL_RC="$HOME/.zshrc"
else
  SHELL_RC="$HOME/.profile"
fi

if ! grep -q 'export PATH="$HOME/bin:$PATH"' "$SHELL_RC" 2>/dev/null; then
  echo '' >> "$SHELL_RC"
  echo '# Add user bin to PATH' >> "$SHELL_RC"
  echo 'export PATH="$HOME/bin:$PATH"' >> "$SHELL_RC"
  warn "Added \$HOME/bin to PATH in $SHELL_RC"
else
  log "\$HOME/bin is already on PATH in $SHELL_RC"
fi

export PATH="$HOME/bin:$PATH"

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-127.0.0.1}"

log "Done!"
log "Visit: http://${HOST_IP}:${PORT}/"
log "Rebuild anytime with: rebuild"
warn "If you want to run docker without sudo, log out and log back in (or reboot)."
warn "If 'rebuild' isn't found immediately, run: source $SHELL_RC"
