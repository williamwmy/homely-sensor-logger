#!/usr/bin/env bash
# Installerer/oppdaterer cron-jobben. Kjøres av deploy.sh med sudo.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")" && pwd)
CRON_FILE=/etc/cron.d/homely-backup

{
  echo 'SHELL=/bin/bash'
  echo 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  # 02:17 UTC hver natt. Litt tilfeldig minutt unngår «hel-time»-belastning.
  echo "17 2 * * * root $REPO_DIR/backup.sh >> /var/log/homely-backup.log 2>&1"
} > "$CRON_FILE"
chmod 0644 "$CRON_FILE"

echo "Daglig databasebackup installert: $CRON_FILE"
