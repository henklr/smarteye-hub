Installation:

Fresh Raspberry Pi 5 install:

curl -fsSL https://raw.githubusercontent.com/henklr/smarteye-hub/main/install.sh | bash

If the repository is private, create a GitHub Personal Access Token (classic) with
`repo` scope at https://github.com/settings/tokens and use it for both the download
and the clone:

curl -fsSL -H "Authorization: token YOUR_TOKEN" \
  https://raw.githubusercontent.com/henklr/smarteye-hub/main/install.sh \
  | GH_TOKEN=YOUR_TOKEN bash

The installer will:

- install Docker and the Docker Compose plugin if needed
- clone or update the repo in $HOME/smarteye-hub
- enable Raspberry Pi I2C support for Automation HAT usage when possible
- start the stack with docker compose

If the script adds your user to the docker group or enables I2C, reboot the Pi before first use.

Optional custom web port:

PORT=8080 curl -fsSL https://raw.githubusercontent.com/henklr/smarteye-hub/main/install.sh | bash
