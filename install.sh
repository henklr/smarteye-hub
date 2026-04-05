#!/usr/bin/env bash

# version 0.3.0
set -euo pipefail

log()  { echo -e "\033[1;32m[setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m  $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

TARGET_USER="${SUDO_USER:-${USER:-$(id -un)}}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-$HOME}"

APP_DIR="${APP_DIR:-$TARGET_HOME/smarteye-hub}"
REPO_URL="https://github.com/henklr/smarteye-hub.git"
PORT="${PORT:-80}"
REBOOT_RECOMMENDED=0

export DEBIAN_FRONTEND=noninteractive
export PORT

docker_accessible() {
  docker info >/dev/null 2>&1
}

docker_compose_available() {
  docker compose version >/dev/null 2>&1 || sudo docker compose version >/dev/null 2>&1
}

run_docker() {
  if docker_accessible; then
    docker "$@"
  else
    sudo docker "$@"
  fi
}

run_compose() {
  if docker_accessible; then
    docker compose "$@"
  else
    warn "Docker daemon not accessible for $TARGET_USER yet — using sudo for docker compose."
    sudo docker compose "$@"
  fi
}

ensure_docker_repo() {
  local os_id codename arch docker_dist

  os_id="$(. /etc/os-release && echo "$ID")"
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  arch="$(dpkg --print-architecture)"

  if [[ -z "$codename" ]]; then
    err "Could not detect OS codename from /etc/os-release."
    exit 1
  fi

  if [[ "$os_id" == "raspbian" ]]; then
    docker_dist="debian"
  else
    docker_dist="$os_id"
  fi

  log "Using Docker apt repository for $docker_dist ($codename, $arch)."

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${docker_dist}/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${docker_dist} ${codename} stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
}

configure_pi_hardware() {
  local model i2c_state

  if [[ ! -r /sys/firmware/devicetree/base/model ]]; then
    return
  fi

  model="$(tr -d '\0' </sys/firmware/devicetree/base/model 2>/dev/null || true)"
  if [[ "$model" != Raspberry\ Pi* ]]; then
    return
  fi

  log "Detected Raspberry Pi hardware: $model"
  log "Installing Raspberry Pi hardware helpers..."
  sudo apt install -y i2c-tools

  if command -v raspi-config >/dev/null 2>&1; then
    i2c_state="$(sudo raspi-config nonint get_i2c 2>/dev/null || true)"
    if [[ "$i2c_state" == "0" ]]; then
      log "I2C is already enabled."
    else
      log "Enabling I2C for Automation HAT support..."
      if sudo raspi-config nonint do_i2c 0; then
        REBOOT_RECOMMENDED=1
      else
        warn "Failed to enable I2C automatically. Enable it manually in raspi-config if Automation HAT access fails."
      fi
    fi
  else
    warn "raspi-config is not available. Ensure I2C is enabled if you plan to use Automation HAT hardware."
  fi

  sudo modprobe i2c-dev >/dev/null 2>&1 || true
}

log "Updating system package lists..."
sudo apt update

log "Installing base prerequisites..."
sudo apt install -y ca-certificates curl git gnupg lsb-release

configure_pi_hardware

if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found. Installing Docker Engine, Buildx, and Compose plugin..."
  ensure_docker_repo
  sudo apt update
  sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker is already installed."
  if ! docker_compose_available; then
    log "Docker Compose plugin is missing. Installing it..."
    if ! sudo apt install -y docker-buildx-plugin docker-compose-plugin; then
      warn "Default apt sources did not provide the Docker Compose plugin. Adding Docker's apt repository."
      ensure_docker_repo
      sudo apt update
      sudo apt install -y docker-buildx-plugin docker-compose-plugin
    fi
  else
    log "Docker Compose plugin already available."
  fi
fi

log "Enabling Docker to start on boot..."
sudo systemctl enable --now docker

log "Verifying Docker..."
if ! run_docker run --rm hello-world >/dev/null 2>&1; then
  warn "Docker test failed. Try: sudo docker run hello-world"
else
  log "Docker OK."
fi

if ! id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx docker; then
  log "Adding user '$TARGET_USER' to docker group..."
  sudo usermod -aG docker "$TARGET_USER"
  REBOOT_RECOMMENDED=1
  warn "Docker group membership will apply after $TARGET_USER logs in again or the Pi reboots."
else
  log "User '$TARGET_USER' is already in docker group."
fi

if [[ -d "$PWD/.git" && -f "$PWD/docker-compose.yml" && -f "$PWD/install.sh" ]]; then
  APP_DIR="$PWD"
  log "Using existing repository at $APP_DIR"
elif [[ -d "$APP_DIR/.git" ]]; then
  if git -C "$APP_DIR" diff --quiet && git -C "$APP_DIR" diff --cached --quiet; then
    log "Repository already exists at $APP_DIR. Pulling latest changes..."
    git -C "$APP_DIR" pull --ff-only
  else
    warn "Repository at $APP_DIR has local changes. Skipping git pull."
  fi
elif [[ -e "$APP_DIR" ]]; then
  err "$APP_DIR already exists but is not a git repository. Move it or set APP_DIR before rerunning the installer."
  exit 1
else
  log "Cloning repository into $APP_DIR..."
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

log "Creating additional files..."
mkdir -p "$APP_DIR/secrets"
if [[ ! -f "$APP_DIR/secrets/openai.env" ]]; then
  echo 'OPENAI_API_KEY=your_openai_api_key_here' > "$APP_DIR/secrets/openai.env"
fi

log "Starting stack with docker compose..."
cd "$APP_DIR"

if ! docker_compose_available; then
  err "docker compose is not available after installation."
  exit 1
fi

run_compose up -d --build

log "Waiting for API health check..."
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    log "API health check passed."
    break
  fi

  if [[ "$attempt" -eq 30 ]]; then
    warn "API health check did not pass yet. Check logs with: cd $APP_DIR && sudo docker compose logs --tail=100"
    break
  fi

  sleep 2
done

log "Services running:"
run_compose ps

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-127.0.0.1}"

log "Done!"
log "UI:      http://${HOST_IP}:${PORT}/"
log "WebRTC:  http://${HOST_IP}:8889/cam1"

if [[ "$REBOOT_RECOMMENDED" -eq 1 ]]; then
  echo
  warn "A reboot is recommended to apply Docker group and Raspberry Pi hardware changes."
  if [[ -t 0 ]]; then
    read -r -p "Reboot now? (y/N): " REBOOT_ANSWER
    if [[ "$REBOOT_ANSWER" =~ ^[Yy]$ ]]; then
      log "Rebooting..."
      sudo reboot
    else
      warn "Skipping reboot. Reboot before using Automation HAT or running docker without sudo."
    fi
  else
    warn "Non-interactive shell detected. Please reboot the Pi manually before first use."
  fi
fi
