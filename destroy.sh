#!/usr/bin/env bash
# River ALT som deploy-flyten har opprettet. Motstykket til terraform apply +
# deploy.sh. Krever eksplisitt bekreftelse.
#
# Bruk: ./destroy.sh           riv homely-logger-rg (VM, nett, disk — og dataene)
#       ./destroy.sh --full    riv også tfstate-rg og NetworkWatcherRG
#
# Rekkefølgen betyr noe:
#   1. siste databasedump reddes til lokal fil (mens VM-en fortsatt lever)
#   2. VM-en meldes ut av tailnettet (ellers blir den liggende som død node)
#   3. terraform destroy
#   4. (--full) state-lagring og NetworkWatcher fjernes med az
set -euo pipefail
cd "$(dirname "$0")"

HOST="azureuser@homely-logger-vm"
FULL=false
[ "${1:-}" = "--full" ] && FULL=true

echo "Dette river hele Homely-loggeren i Azure, inkludert databasen med all historikk."
$FULL && echo "--full: fjerner også Terraform-state-lagringen (tfstate-rg) og NetworkWatcherRG."
read -r -p "Skriv 'riv alt' for å fortsette: " SVAR
[ "$SVAR" = "riv alt" ] || { echo "Avbrutt."; exit 1; }

# 1. Siste dump av databasen — koster sekunder, redder historikken
DUMP="homely-events-$(date +%Y%m%d-%H%M%S).sql.gz"
echo "Tar avskjedsdump av databasen til ./$DUMP ..."
if ssh -o ConnectTimeout=15 "$HOST" \
    'cd homely-sensor-logger/app && docker compose exec -T db pg_dump -U homely homely' \
    | gzip > "$DUMP"; then
  echo "Dump lagret: $DUMP ($(du -h "$DUMP" | cut -f1))"
else
  rm -f "$DUMP"
  read -r -p "Fikk ikke tatt dump (VM nede?). Fortsette uten? [ja/N] " U
  [ "$U" = "ja" ] || exit 1
fi

# 2. Meld VM-en ut av tailnettet (best effort — VM-en dør uansett)
echo "Melder VM-en ut av tailnettet ..."
ssh -o ConnectTimeout=15 "$HOST" 'sudo tailscale logout' \
  || echo "(fikk ikke logget ut — fjern noden manuelt på login.tailscale.com/admin/machines)"

# 3. Riv infrastrukturen
echo "Kjører terraform destroy ..."
terraform -chdir=infra destroy -auto-approve

# 4. Valgfritt: alt utenfor Terraform
if $FULL; then
  echo "Fjerner tfstate-rg og NetworkWatcherRG ..."
  az group delete --name tfstate-rg --yes
  az group delete --name NetworkWatcherRG --yes 2>/dev/null \
    || echo "(NetworkWatcherRG fantes ikke — greit)"
fi

echo
echo "Ferdig. Gjenstår manuelt (kan ikke scriptes):"
echo "  - ntfy-appen: abonnementene kan slettes (topics er tilstandsløse)"
echo "  - Tailscale-admin: sjekk at homely-logger-vm er borte fra maskinlisten"
$FULL || echo "  - tfstate-rg står igjen (øre/mnd) — kjør med --full for å fjerne den også"
echo "  - Databasedumpen ligger i: $DUMP  (gjenopprett: gunzip -c $DUMP | psql ...)"
