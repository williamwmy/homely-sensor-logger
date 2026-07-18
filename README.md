# Homely Sensor Logger

Logger alle sensor-triggere fra Homely-alarmsystemet til Postgres, slik at hele
historikken bevares — Homely-appen viser bare siste aktivitet.

- `infra/` — Terraform for en liten Ubuntu-VM i Azure (Norway East) med Docker.
- `app/` — Docker Compose med `collector` (Node) og `db` (Postgres 16).

Appen har ingen Azure-avhengigheter og kan flyttes rett over på en Raspberry Pi
eller VPS: kopier `app/`-mappen, sett opp `.env`, kjør `docker compose up -d`.

## Oppstart

### 1. Infrastruktur

Krever Terraform og en aktiv `az login`-sesjon (f.eks. Azure Cloud Shell).

```bash
cd infra
./bootstrap-state.sh                           # engangs: storage for remote state
cp terraform.tfvars.example terraform.tfvars   # fyll inn IP og SSH-nøkkel
terraform init
terraform apply
```

Terraform-staten lagres i en Azure Storage-konto (`azurerm`-backend), så den
følger Azure-kontoen din og ikke maskinen du kjører fra.

Output viser offentlig IP og en ferdig `ssh`-kommando.

### 2. Applikasjon

SSH inn på VM-en (cloud-init har allerede installert Docker — gi den et par
minutter etter første oppstart):

```bash
ssh azureuser@<public_ip>
git clone <repo-url>
cd homely-sensor-logger/app
cp .env.example .env   # fyll inn Homely-innlogging og Postgres-passord
docker compose up -d
docker compose logs -f collector   # sjekk at den logger inn og kobler til
```

## Mobil: dashboard og push-varsler

- **Grafana** (dashboard): kjører på VM-en, port 3000 — bevisst ikke åpnet i
  NSG-en. Nås via [Tailscale](https://tailscale.com): installer på VM-en
  (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`) og
  på mobilen, logg inn på samme konto, og åpne `http://<vm-tailscale-navn>:3000`.
  Innlogging: `admin` + `GRAFANA_ADMIN_PASSWORD` fra `.env`.
- **Push-varsler** (ntfy): `notifier`-tjenesten lytter på nye events i Postgres
  og sender til ntfy-topics. Installer [ntfy-appen](https://ntfy.sh) og abonner på:
  - `homely-<NTFY_TOPIC_SECRET>-dor` — dører åpnes/lukkes
  - `homely-<NTFY_TOPIC_SECRET>-sikkerhet` — røyk/brann og sabotasje
  - `homely-<NTFY_TOPIC_SECRET>-batteri` — lavt batteri

  Topic-navnene er hemmeligheten — del dem ikke. Hvilke devices som ikke skal
  varsle styres med `NOTIFY_IGNORE_DEVICES` i `.env`.

## Eksempel-spørringer

Åpne en psql-sesjon i db-containeren:

```bash
docker compose exec db psql -U homely homely
```

Alle events for en gitt device siste uke:

```sql
SELECT last_updated, feature, state_name, value, source
FROM events
WHERE device_name = 'Entrédør'
  AND last_updated > now() - interval '7 days'
ORDER BY last_updated DESC;
```

Antall triggere per sensor per dag:

```sql
SELECT device_name,
       date_trunc('day', last_updated) AS dag,
       count(*) AS antall
FROM events
GROUP BY device_name, dag
ORDER BY dag DESC, antall DESC;
```

Hvilke devices finnes i loggen:

```sql
SELECT DISTINCT device_id, device_name FROM events ORDER BY device_name;
```
