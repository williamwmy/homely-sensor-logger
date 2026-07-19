#!/usr/bin/env bash
# Ukentlig auto-oppdatering — kjøres av cron på VM-en (se /etc/cron.d/homely-update).
# Oppdaterer OS-pakker (inkl. Docker og Tailscale) og Docker-images (Grafana,
# Postgres-minor), rydder gamle images, og rebooter hvis kjernen krever det.
#
# Varsling til ntfy status-topicet:
#   - stille når det ikke fantes oppdateringer
#   - lav prioritet når noe ble oppdatert og helsesjekken er grønn
#   - høy prioritet hvis noe feilet (da vet du at det er feilsøkingstid)
set -uo pipefail

APP_DIR="/home/azureuser/homely-sensor-logger/app"
cd "$APP_DIR" || exit 1

NTFY_BASE_URL=$(grep '^NTFY_BASE_URL=' .env | cut -d= -f2-)
NTFY_BASE_URL=${NTFY_BASE_URL:-https://ntfy.sh}
SECRET=$(grep '^NTFY_TOPIC_SECRET=' .env | cut -d= -f2-)

notify() { # $1=prioritet(tall) $2=tittel $3=melding (unngå " og linjeskift)
  curl -fsS -o /dev/null --max-time 20 -X POST "$NTFY_BASE_URL" \
    -H 'content-type: application/json' \
    -d "{\"topic\":\"homely-${SECRET}-status\",\"title\":\"$2\",\"message\":\"$3\",\"priority\":$1,\"tags\":[\"arrows_counterclockwise\"]}" \
    || true
}

grafana_version() {
  curl -fsS --max-time 10 http://localhost:3000/api/health 2>/dev/null \
    | grep -o '"version": *"[^"]*"' | cut -d'"' -f4
}

FEIL=()
ENDRINGER=()

# 1. OS-pakker (dekker også Docker og Tailscale, som har egne apt-repoer
#    unattended-upgrades ikke rører)
apt-get update -qq || FEIL+=("apt update")
ANTALL_PAKKER=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst ' || true)
if [ "$ANTALL_PAKKER" -gt 0 ]; then
  if DEBIAN_FRONTEND=noninteractive apt-get -y -qq \
       -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" \
       upgrade > /dev/null 2>&1; then
    ENDRINGER+=("$ANTALL_PAKKER OS-pakker")
  else
    FEIL+=("apt upgrade")
  fi
fi

# 2. Docker-images (grafana:latest, postgres:16-minor). Collector/notifier
#    bygges lokalt og hoppes over (--ignore-buildable).
GRAFANA_FOER=$(grafana_version)
ids() { docker compose config --images 2>/dev/null | sort -u \
        | xargs -r -n1 docker image inspect --format '{{.Id}}' 2>/dev/null | sort; }
FOER=$(ids)
docker compose pull --ignore-buildable -q > /dev/null 2>&1 || FEIL+=("compose pull")
ETTER=$(ids)

if [ "$FOER" != "$ETTER" ]; then
  if docker compose up -d > /dev/null 2>&1; then
    sleep 25
    GRAFANA_NAA=$(grafana_version)
    if [ -n "$GRAFANA_NAA" ] && [ "$GRAFANA_NAA" != "$GRAFANA_FOER" ]; then
      ENDRINGER+=("Grafana $GRAFANA_FOER → $GRAFANA_NAA")
    else
      ENDRINGER+=("nye container-images")
    fi
  else
    FEIL+=("compose up")
  fi
  docker image prune -f > /dev/null 2>&1
fi

# 3. Helsesjekk etter oppdatering (bare hvis noe ble endret)
if [ ${#ENDRINGER[@]} -gt 0 ] || [ ${#FEIL[@]} -gt 0 ]; then
  sleep 5
  NEDE=$(docker compose ps --format '{{.Name}}: {{.Status}}' | grep -v ' Up' || true)
  [ -n "$NEDE" ] && FEIL+=("container nede: ${NEDE//$'\n'/, }")
  curl -fsS -o /dev/null --max-time 10 http://localhost:3000/api/health || FEIL+=("grafana svarer ikke")
fi

# 4. Varsle — stille hvis ingenting skjedde
if [ ${#FEIL[@]} -gt 0 ]; then
  notify 4 "Auto-oppdatering: FEIL" "Feilet: ${FEIL[*]}. Oppdatert: ${ENDRINGER[*]:-ingenting}. Sjekk /var/log/homely-update.log på VM-en."
elif [ ${#ENDRINGER[@]} -gt 0 ]; then
  MELDING="Oppdatert: ${ENDRINGER[*]}. Alt kjører."
  if [ -f /var/run/reboot-required ]; then
    notify 2 "Auto-oppdatering" "$MELDING Rebooter nå for ny kjerne — tilbake om ~2 min."
  else
    notify 2 "Auto-oppdatering" "$MELDING"
  fi
fi

# 5. Reboot til slutt hvis kjernen krever det (containerne har
#    restart: unless-stopped og kommer opp av seg selv)
if [ -f /var/run/reboot-required ]; then
  sleep 5
  /sbin/reboot
fi
