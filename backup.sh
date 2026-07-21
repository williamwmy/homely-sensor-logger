#!/usr/bin/env bash
# Daglig, transaksjonskonsistent pg_dump til privat Azure Blob Storage.
# Autentisering skjer med VM-ens managed identity; ingen lagringsnøkkel trengs.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR="$REPO_DIR/app"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

notify_failure() {
  local base secret
  base=$(grep '^NTFY_BASE_URL=' "$APP_DIR/.env" | cut -d= -f2- || true)
  base=${base:-https://ntfy.sh}
  secret=$(grep '^NTFY_TOPIC_SECRET=' "$APP_DIR/.env" | cut -d= -f2- || true)
  [ -n "$secret" ] || return 0
  curl -fsS -o /dev/null --max-time 20 \
    -H 'Title: Databasebackup feilet' -H 'Priority: high' -H 'Tags: floppy_disk' \
    -d 'Den daglige PostgreSQL-backupen feilet. Sjekk /var/log/homely-backup.log.' \
    "$base/homely-$secret-status" || true
}
trap 'notify_failure' ERR

# Kontonavnet kan overstyres ved behov. Standardnavnet matcher Terraform og er
# deterministisk per Azure-subscription.
if [ -z "${BACKUP_STORAGE_ACCOUNT:-}" ]; then
  subscription_id=$(curl -fsS -H Metadata:true \
    'http://169.254.169.254/metadata/instance/compute/subscriptionId?api-version=2021-02-01&format=text')
  account_suffix=$(printf '%s' "$subscription_id" | tr '[:upper:]' '[:lower:]' | md5sum | cut -c1-10)
  BACKUP_STORAGE_ACCOUNT="homelybackup${account_suffix}"
fi

# Hopp stille ut hvis backup-infrastrukturen ikke er provisjonert enda
# (terraform apply ikke kjørt). En ikke-eksisterende konto gir NXDOMAIN, så
# vi unngår å lage en kastet dump og spamme status-topicet med feilvarsel
# hver natt. Reell feil på en eksisterende konto varsles fortsatt via ERR.
account_host="${BACKUP_STORAGE_ACCOUNT}.blob.core.windows.net"
if ! getent hosts "$account_host" >/dev/null 2>&1; then
  echo "Storage account $account_host finnes ikke enda — hopper over backup (kjør terraform apply)."
  exit 0
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
dump_file="$TMP_DIR/homely-$timestamp.dump"
blob_name="database/homely-$timestamp.dump"

cd "$APP_DIR"
docker compose exec -T db sh -c \
  'pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$dump_file"
test -s "$dump_file"

token=$(curl -fsS -H Metadata:true \
  'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F' \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
request_date=$(LC_ALL=C date -u +"%a, %d %b %Y %H:%M:%S GMT")

curl --fail-with-body -sS -o /dev/null -X PUT --upload-file "$dump_file" \
  -H "Authorization: Bearer $token" \
  -H "x-ms-date: $request_date" \
  -H 'x-ms-version: 2023-11-03' \
  -H 'x-ms-blob-type: BlockBlob' \
  "https://${BACKUP_STORAGE_ACCOUNT}.blob.core.windows.net/backups/${blob_name}"

size=$(du -h "$dump_file" | cut -f1)
echo "Backup lastet opp: backups/$blob_name ($size)"
