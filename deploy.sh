#!/usr/bin/env bash
# Deployer siste commit fra GitHub til VM-en og bygger containerne på nytt.
# Husk å committe og pushe først — scriptet deployer det som ligger på GitHub.
#
# Bruk: ./deploy.sh                    (default host)
#       ./deploy.sh bruker@annen-host  (overstyr, f.eks. Tailscale-navn)
set -euo pipefail

# SSH går via Tailscale (port 22 er stengt offentlig) — Mac-en må være i tailnettet.
HOST="${1:-azureuser@homely-logger-vm}"

echo "Deployer til $HOST ..."
ssh "$HOST" '
  set -e
  cd homely-sensor-logger
  git pull
  cd app
  docker compose up -d --build
  echo
  docker compose ps --format "table {{.Name}}\t{{.Status}}"
'
echo "Ferdig."
