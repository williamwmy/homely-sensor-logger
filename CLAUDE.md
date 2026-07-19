# Homely Sensor Logger

## Formål
Logg alle sensor-triggere fra Homely-alarmsystemet til en database, slik at hele
historikken bevares. Homely-appen viser bare siste aktivitet; dette prosjektet
bygger et permanent, spørrbart eventlager.

## Arkitektur
- Én liten Linux-VM (Ubuntu) i Azure, Norway East, på MSDN-kreditt.
- Docker Compose med fire tjenester:
  - `collector` — Node; websocket + polling mot Homely, skriver til Postgres
  - `db` — Postgres 16, append-only `events`-tabell
  - `notifier` — Node (samme image som collector, annen kommando); lytter på
    nye rader via LISTEN/NOTIFY og sender push-varsler til ntfy
  - `grafana` — dashboard, provisjonert fra `app/grafana/` (datasource +
    dashboard som kode)
- All config i `.env`. Ingen hemmeligheter i koden eller i git.
- Bevisst flyttbart: samme compose skal kunne kjøre uendret på en Raspberry Pi
  eller VPS hvis Azure-kreditten forsvinner. Ingen Azure-spesifikke avhengigheter
  i selve appen. (Tailscale og ntfy er også plattformnøytrale.)
- Infrastruktur som kode med Terraform (azurerm-provider, remote state i
  Azure Storage).
- Tilgang: **ingen åpne porter i NSG-en.** SSH og Grafana går via Tailscale
  (VM, mobil og Mac i samme tailnet). Ved førstegangsoppsett av en fersk VM
  åpnes port 22 midlertidig med az-kommandoen i `infra/terraform.tfvars.example`;
  neste `terraform apply` fjerner den automatisk.

## Homely-API
Read-only beta-API. Ingen offentlig dokumentasjon; strukturen under er verifisert
mot en ekte konto og mot referanseimplementasjonene (se nederst).

Base URL: `https://sdk.iotiliti.cloud`

### Autentisering
OAuth2 password grant:
`POST /homely/oauth/token` med JSON-body `{"username": "<epost>", "password": "<passord>"}`.
Svaret inneholder `access_token` (JWT), `refresh_token`, `expires_in`.
Tokenet utløper, så collectoren må friske det opp (via `refresh_token`, eller ny
innlogging) før utløp — både for REST-polling og for websocketen.

### REST
- `GET /homely/locations` → liste over hjem, hver med `locationId` (UUID),
  `name`, `gatewayserial`.
- `GET /homely/home/<locationId>` → full tilstand: `alarmState` og `devices[]`.
  Hver device har `id`, `name`, `location`, `online`, og `features` med nested
  `states`. Hver state har `value` og `lastUpdated`.

Alle kall krever header `Authorization: Bearer <access_token>`.

### Streaming (Socket.IO)
Endpoint: `wss://sdk.iotiliti.cloud/socket.io/`
Autentiseres via query-parametere (uvanlig, men slik er det):
- `token=Bearer <JWT>`
- `EIO=4`
- `transport=websocket`
- `locationId=<locationId>` — NB: parameteren heter `locationId`, ikke
  `location` slik enkelte referanser skriver. Verifisert 2026-07-18: serveren
  validerer `locationId` (isUuid) og disconnecter klienter uten den, med en
  `exception`-event som eneste forvarsel.

Event `device-state-changed` har `data` med `deviceId`, `gatewayId`,
`locationId`, `modelId`, `rootLocationId`, `changes[]`. Hver `change`:
`feature`, `stateName`, `value`, `lastUpdated`.

### VIKTIG: websocket alene er ikke nok
I flere oppsett streames bare et delsett av features (typisk temperatur og
nettverkstilkobling), ikke alle dør- og bevegelses-events. Derfor MÅ collectoren
også polle `GET /homely/home/<locationId>` jevnlig (default hvert 20. minutt —
Homelys rate-limiter er stram og noe uforutsigbar: 2, 10 og 15 minutters
polling ga alle jevnlig HTTP 429),
sammenligne `lastUpdated`-timestamps mot sist lagrede verdi per
(device, feature, state), og skrive inn endringer websocketen bommet på.
Polling er en kjernefunksjon, ikke en reserve. Websocketen faller også ut
innimellom, så polling er dobbelt viktig.

## Datamodell
Append-only. Skriv aldri over, bare legg til.

Tabell `events`:
- `id` bigserial PK
- `received_at` timestamptz default now()
- `device_id` text
- `device_name` text
- `feature` text
- `state_name` text
- `value` jsonb (tåler bool, tall, tekst)
- `last_updated` timestamptz (Homelys egen timestamp for endringen)
- `source` text ('websocket' eller 'poll')

Websocket og polling vil overlappe. Gjør en rad unik på
(device_id, feature, state_name, last_updated) med en unik constraint, og bruk
`INSERT ... ON CONFLICT DO NOTHING` så samme endring ikke logges to ganger.

I tillegg til tabellen:
- Trigger `events_notify` (AFTER INSERT) gjør `pg_notify('events_channel',
  row_to_json(NEW))` — notifier-tjenesten lytter på denne kanalen.
- Egen leserolle `grafana_reader` (kun SELECT på `events`) for Grafana.
- NB: init-scriptene i `app/db/` kjører kun på ferskt Postgres-volum. Endringer
  i skjemaet må også migreres manuelt inn i en kjørende database med
  `docker compose exec db psql`.

## Innsyn og varsler
- **Grafana** (`app/grafana/`): datasource og dashboard provisjoneres som kode.
  Innlogging admin + `GRAFANA_ADMIN_PASSWORD`. Nås kun via Tailscale:
  `http://homely-logger-vm:3000`.
- **Push** (`app/collector/src/notifier.js`): ntfy.sh med hemmelige topic-navn
  `homely-<NTFY_TOPIC_SECRET>-{dor,sikkerhet,batteri}`. Regler:
  - dør (feature=alarm, state=alarm, value true=åpnet/false=lukket) → `-dor`;
    devices i `NOTIFY_IGNORE_DEVICES` (default Bevegelsessensor) varsles ikke
  - fire → `-sikkerhet` (priority urgent); tamper → `-sikkerhet` (high)
  - battery low/defect → `-batteri` (low)
  - Stale-vern: events med `last_updated` eldre enn `NOTIFY_MAX_AGE_SECONDS`
    (default 900) varsles aldri — hindrer varselflom når polling tar igjen
    etterslep etter nedetid. ntfy.sh ser varselinnholdet (bevisst valg);
    self-hosting av ntfy er exit-strategien hvis det blir et problem.
- **Homely rate-limiter** `/homely/home` (HTTP 429) ved hyppige kall — typisk
  utløst av mange restarter/manuelle kall på kort tid, ikke av normal
  2-minutters-polling. Polleren håndterer det med eksponentiell backoff
  (dobling per 429, maks 15 min). 429 gir forsinkelse, aldri datatap.

## Konvensjoner
- Språk: Node (JavaScript eller TypeScript). `socket.io-client` for streaming
  (offisiell klient, håndterer EIO=4, handshake, ping/pong og reconnect),
  `undici`/`fetch` for REST, `pg` for Postgres.
  Homely-serveren er selv Socket.IO, så socket.io-client er hjemmebane og skjuler
  protokoll-detaljene. Den udokumenterte query-param-autentiseringen settes via
  `io(url, { query: { token: "Bearer <JWT>", locationId: "<locationId>" },
  transports: ["websocket"] })` (se NB om parameternavnet under Streaming).
- Websocket-lytter og polling-loop kjører parallelt (to async-funksjoner i samme
  prosess). Begge skriver til samme `events`-tabell via samme insert-funksjon.
- Merk: referanseimplementasjonen hansrune/homely-tools er i Python. Bruk den som
  språkuavhengig oppslagsverk for token-flyt, feltnavn og poll-logikk, men skriv
  selve collectoren i Node.
- Reconnect med backoff når websocketen dropper. Frisk token ved reconnect.
- Ingen hemmeligheter i git. `.env` i `.gitignore`, med `.env.example` som mal.
- Strukturert logging til stdout (Docker fanger det). Logg hver insert på
  debug-nivå, hver reconnect/feil på info/warn.
- `restart: unless-stopped` på alle containere.
- Postgres-data i et navngitt Docker-volume så det overlever restart.

## Referanser (de facto-dokumentasjon)
- `kongsvik.dev/posts/exploring-homely` — token-flyt, endepunkter,
  Socket.IO-detaljer (query-param-auth, EIO=4), og datastrukturer.
- `github.com/hansrune/homely-tools` — kjørende Python-impl med både polling og
  websocket. Nærmeste ting til en fasit.
- `github.com/kolaf/homelypy` — minimal REST-wrapper.