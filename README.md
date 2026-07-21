# Homely Sensor Logger

Logger alle sensor-triggere fra Homely-alarmsystemet til Postgres, slik at hele
historikken bevares — Homely-appen viser bare siste aktivitet.

- `infra/` — Terraform for en liten Ubuntu-VM i Azure (Norway East) med Docker.
- `app/` — Docker Compose med seks langvarige tjenester: `collector` (Node, websocket +
  polling mot Homely), `db` (Postgres 16), `notifier` (push-varsler via ntfy),
  `grafana` (dashbord), `met` (vær fra MET/Frost) og `netatmo` (offentlige
  nabo-værstasjoner), pluss en kortlivet `migrate`-tjeneste før oppstart.
  `met` og `netatmo` sover til de får credentials i `.env`.

Appen har ingen Azure-avhengigheter og kan flyttes rett over på en Raspberry Pi
eller VPS: kopier `app/`-mappen, sett opp `.env`, kjør `docker compose up -d`.

## Oppstart

### 1. Infrastruktur

Krever Terraform og en aktiv `az login`-sesjon (f.eks. Azure Cloud Shell).

```bash
cd infra
./bootstrap-state.sh                           # engangs: storage for remote state
cp terraform.tfvars.example terraform.tfvars   # fyll inn SSH-nøkkel
terraform init
terraform apply
```

VM-en har ingen åpne porter — all tilgang (SSH og Grafana) går via Tailscale.
Ved førstegangsoppsett: åpne port 22 midlertidig med az-kommandoen i
`terraform.tfvars.example`, sett opp Tailscale på VM-en, og kjør
`terraform apply` igjen (fjerner regelen automatisk).

Terraform-staten lagres i en Azure Storage-konto (`azurerm`-backend), så den
følger Azure-kontoen din og ikke maskinen du kjører fra.

Output viser offentlig IP og en ferdig `ssh`-kommando.

### 2. Applikasjon

SSH inn på VM-en (cloud-init har allerede installert Docker — gi den et par
minutter etter første oppstart):

```bash
ssh azureuser@homely-logger-vm   # via Tailscale (public IP ved førstegangsoppsett)
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

VM-en oppdaterer seg selv ukentlig (mandager 03:30 UTC) via `update.sh` som
cron-jobb: OS-pakker, Docker/Tailscale og container-images (Grafana, Postgres),
med auto-reboot ved kjerneoppdatering. Resultatet meldes på ntfy-`status`-topicet
— stille ved ingen endring, lav prioritet ved oppdatering, høy ved feil.

### Databasebackup

Terraform oppretter en privat Azure Storage Account og gir VM-ens managed
identity skrivetilgang. `deploy.sh` installerer en cron-jobb som hver natt 02:17
UTC tar en komprimert, transaksjonskonsistent `pg_dump` og laster den opp til
`backups/database/`. Backuper eldre enn `backup_retention_days` (default 30)
slettes automatisk. Ingen lagringsnøkkel ligger på VM-en.

Etter oppgradering av en eksisterende installasjon må infrastrukturen opprettes
først, deretter deployes applikasjonen:

```bash
terraform -chdir=infra apply
./deploy.sh
```

Test en manuell backup på VM-en med `sudo ./backup.sh`. Feil varsles på
ntfy-`status`-topicet og logges i `/var/log/homely-backup.log`. En dump kan
lastes ned fra Storage Account-en og gjenopprettes med `pg_restore`.

## Rive alt

```bash
./destroy.sh          # avskjedsdump av databasen → tailscale logout → terraform destroy
./destroy.sh --full   # river også tfstate-rg og NetworkWatcherRG
```

Scriptet krever eksplisitt bekreftelse og redder en komprimert `pg_dump`
til lokal fil før VM-en (og dermed databasen) forsvinner.

## Mobil: dashboard og push-varsler

### Grafana (dashboard)

Kjører på VM-en, port 3000 — bevisst ikke åpnet i NSG-en, nås kun via
[Tailscale](https://tailscale.com) (gratis):

1. På VM-en: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
   — kommandoen skriver ut en innloggings-URL. Åpne den i nettleseren, logg inn
   og godkjenn («Connect») at maskinen legges til i tailnettet ditt.
2. Installer Tailscale-appen på mobilen og logg inn på samme konto.
3. Åpne `https://homely-logger-vm.<tailnet>.ts.net` — HTTPS med ekte
   Let's Encrypt-sertifikat via `tailscale serve` (satt opp med
   `sudo tailscale serve --bg 3000`; krever at Serve er aktivert i
   tailnet-innstillingene, uten Funnel). Fortsatt kun nåbar i tailnettet.
   Reserve: `http://homely-logger-vm:3000`.
   Innlogging: `admin` + `GRAFANA_ADMIN_PASSWORD` fra `.env`.

Dashboardet «Homely Sensor Logger» provisjoneres automatisk fra
`app/grafana/dashboards/` — endringer der følger git, ikke klikking i UI-et.

### Push-varsler (ntfy)

`notifier`-tjenesten legger nye events i en varig databasekø og sender dem til
[ntfy](https://ntfy.sh)-topics. Mislykket levering forsøkes igjen med backoff;
LISTEN/NOTIFY brukes bare for å vekke køleseren raskt. Sett
`NTFY_TOPIC_SECRET` i `.env`
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

Databaseskjemaet oppgraderes automatisk av `migrate` før de andre tjenestene
starter. Kjørte migreringer registreres i `schema_migrations`; nye endringer
legges som nummererte SQL-filer i `app/db/migrations/`.

## Værdata (valgfritt): ute-mot-inne

Dashbordet «Vær — MET vs. inneklima» sammenligner innesensorene med utetemperatur,
sol, vind og nedbør. To valgfrie kilder, begge sover til de får credentials:

- **MET/Frost** — gratis client-ID fra [frost.met.no](https://frost.met.no) i
  `FROST_CLIENT_ID`. Henter fra nærmeste stasjoner (`MET_STATION_ID`, default
  Hovin + Blindern). Historikk kan backfilles med `MET_LOOKBACK_HOURS` +
  `MET_ONESHOT=1`.
- **Netatmo** — offentlige nabo-værstasjoner rundt `NETATMO_LAT`/`NETATMO_LON`.
  Opprett app + generer token (scope `read_station`) på
  [dev.netatmo.com/apps](https://dev.netatmo.com/apps), sett `NETATMO_CLIENT_ID`,
  `NETATMO_CLIENT_SECRET` og `NETATMO_REFRESH_TOKEN`. NB: `getpublicdata` gir kun
  siste måling — ingen historikk å hente. Dashbordet viser medianen av
  stasjonene innenfor 200 m med et p25–p75-bånd (bredden = usikkerheten);
  kalibrert Frost Hovin er ankeret når nabolaget spriker i sol.

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
