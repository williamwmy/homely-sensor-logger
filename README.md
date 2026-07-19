# Homely Sensor Logger

Logger alle sensor-triggere fra Homely-alarmsystemet til Postgres, slik at hele
historikken bevares — Homely-appen viser bare siste aktivitet.

- `infra/` — Terraform for en liten Ubuntu-VM i Azure (Norway East) med Docker.
- `app/` — Docker Compose med fire tjenester: `collector` (Node, websocket +
  polling mot Homely), `db` (Postgres 16), `notifier` (push-varsler via ntfy)
  og `grafana` (dashboard).

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

Senere deployer (etter `git push`) gjøres fra din egen maskin med:

```bash
./deploy.sh   # ssh + git pull + docker compose up -d --build på VM-en
```

## Mobil: dashboard og push-varsler

### Grafana (dashboard)

Kjører på VM-en, port 3000 — bevisst ikke åpnet i NSG-en, nås kun via
[Tailscale](https://tailscale.com) (gratis):

1. På VM-en: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
   — kommandoen skriver ut en innloggings-URL. Åpne den i nettleseren, logg inn
   og godkjenn («Connect») at maskinen legges til i tailnettet ditt.
2. Installer Tailscale-appen på mobilen og logg inn på samme konto.
3. Åpne `http://homely-logger-vm:3000` (eller Tailscale-IP-en fra
   `tailscale ip -4`). Innlogging: `admin` + `GRAFANA_ADMIN_PASSWORD` fra `.env`.

Dashboardet «Homely Sensor Logger» provisjoneres automatisk fra
`app/grafana/dashboards/` — endringer der følger git, ikke klikking i UI-et.

### Push-varsler (ntfy)

`notifier`-tjenesten lytter på nye events i Postgres (LISTEN/NOTIFY) og sender
til [ntfy](https://ntfy.sh)-topics. Sett `NTFY_TOPIC_SECRET` i `.env`
(generer med `openssl rand -hex 16`), installer ntfy-appen og abonner på:

- `homely-<NTFY_TOPIC_SECRET>-dor` — dører åpnes/lukkes
- `homely-<NTFY_TOPIC_SECRET>-sikkerhet` — røyk/brann og sabotasje (høy prioritet)
- `homely-<NTFY_TOPIC_SECRET>-batteri` — lavt batteri
- `homely-<NTFY_TOPIC_SECRET>-status` — daglig hjertebank (kl. `HEARTBEAT_HOUR`,
  default 08). **Uteblir denne, er noe nede** — det er hele poenget med den.

Topic-navnene er hemmeligheten — del dem ikke (alle som kjenner navnet kan lese
varslene på ntfy.sh). Devices som ikke skal gi dørvarsler styres med
`NOTIFY_IGNORE_DEVICES` i `.env` (default: Bevegelsessensor). Events eldre enn
`NOTIFY_MAX_AGE_SECONDS` varsles aldri, så poll-etterslep etter nedetid ikke
gir varselflom.

**Oppgraderer du en eksisterende installasjon** (Postgres-volum fra før
notifier/Grafana fantes): init-scriptene i `app/db/` kjører kun på ferske
volumer, så pg_notify-triggeren og `grafana_reader`-rollen må legges inn
manuelt med `docker compose exec db psql -U homely homely` (se `app/db/`).

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
