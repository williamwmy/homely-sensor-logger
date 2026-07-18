#!/usr/bin/env bash
# Engangs-oppsett av lagring for Terraform remote state. Kjør i Azure Cloud
# Shell (allerede innlogget med az):
#   ./bootstrap-state.sh
#
# Trygt å kjøre flere ganger — alle kommandoene er idempotente.
# Storage-kontonavnet må være globalt unikt og matche backend-blokken i main.tf.
set -euo pipefail

LOCATION="norwayeast"
RG="tfstate-rg"
ACCOUNT="williamwmytfstate"
CONTAINER="tfstate"

echo "Sjekker at kontonavnet '$ACCOUNT' er ledig eller allerede ditt ..."
AVAILABLE=$(az storage account check-name --name "$ACCOUNT" --query nameAvailable -o tsv)
if [ "$AVAILABLE" = "false" ] && ! az storage account show --name "$ACCOUNT" --resource-group "$RG" --output none 2>/dev/null; then
  echo "FEIL: '$ACCOUNT' er tatt av noen andre. Velg et nytt navn her og i backend-blokken i main.tf." >&2
  exit 1
fi

az group create --name "$RG" --location "$LOCATION" --output none

az storage account create \
  --name "$ACCOUNT" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --output none

az storage container create \
  --name "$CONTAINER" \
  --account-name "$ACCOUNT" \
  --auth-mode key \
  --output none

echo "Remote state klar: $ACCOUNT/$CONTAINER i $RG"
echo "Kjør nå: terraform init            (første gang)"
echo "eller:   terraform init -migrate-state   (hvis du har lokal state fra før)"
