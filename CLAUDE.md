# Homely Sensor Logger

## Formål
Logg alle sensor-triggere fra Homely-alarmsystemet til en database, slik at hele
historikken bevares. Homely-appen viser bare siste aktivitet; dette prosjektet
bygger et permanent, spørrbart eventlager.

## Arkitektur
- Én liten Linux-VM (Ubuntu) i Azure, Norway East, på MSDN-kreditt.
- Docker Compose med seks tjenester:
  - `collector` — Node; websocket + polling mot Homely, skriver til Postgres
  - `db` — Postgres 16, append-only `events`-tabell
  - `notifier` — Node (samme image som collector, annen kommando); lytter på
    nye rader via LISTEN/NOTIFY og sender push-varsler til ntfy
  - `grafana` — dashboard, provisjonert fra `app/grafana/` (datasource +
    to dashbord som kode: sensor-oversikt og «Vær — MET vs. inneklima»).
    Per-dør-panelene er selvkonfigurerende: ett repeterende panel drevet av en
    `door`-variabel (`SELECT DISTINCT device_name` der feature=alarm), så nye
    sensorer i Homely dukker opp automatisk uten kode-/dashbord-endring.
  - `met` — værpoller mot MET/Frost-API-et (utetemp, globalstråling, vind,
    nedbør → source='met'). Sover uten `FROST_CLIENT_ID`.
  - `netatmo` — poller offentlige nabostasjoner (getpublicdata) rundt et
    senterpunkt → source='netatmo'. Sover uten `NETATMO_*`-credentials.
  De to sistnevnte er samme image som collector, egen kommando.
- Alle tjenester har logg-rotasjon (10 MB × 3) via `x-logging`-anker.
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
- `last_updated` timestamptz (kildens egen timestamp for endringen)
- `source` text ('websocket', 'poll', 'met' eller 'netatmo')

Alle datakilder deler samme skjema — Homely-events, MET-vær og Netatmo-naboer
er bare rader med ulik `source`/`feature`/`state_name`. Derfor kunne værdata
legges til uten å endre skjemaet.

Websocket og polling vil overlappe. Gjør en rad unik på
(device_id, feature, state_name, last_updated) med en unik constraint, og bruk
`INSERT ... ON CONFLICT DO NOTHING` så samme endring ikke logges to ganger.

Tabell `app_state` (key/value): tjeneste-tilstand som må overleve restart —
p.t. Netatmos roterende refresh-token (engangsbruk; det nye tokenet fra hver
fornyelse lagres her, ikke i `.env`).

I tillegg til tabellene:
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
- **Homely rate-limiter** `/homely/home` (HTTP 429): stram, målt ~4 vellykkede
  kall i timen. 2, 10 og 15 min polling ga alle jevnlig 429 (2026-07-19);
  default er derfor 20 min (`POLL_INTERVAL_SECONDS=1200`). Polleren håndterer
  429 med eksponentiell backoff (dobling, maks 15 min). Gir forsinkelse, aldri
  datatap — websocketen bærer sanntid.

## Værkilder (ute-mot-inne)
- **MET/Frost** (`met.js`): historikk *kan* backfilles (`MET_LOOKBACK_HOURS`
  + `MET_ONESHOT=1`). Hybrid stasjonsoppsett: Hovin (SN18210, temp/vind/nedbør,
  nær Ensjø) + Blindern (SN18700, eneste i Oslo med globalstråling).
- **Netatmo** (`netatmo.js`): `getpublicdata` gir KUN siste måling per offentlig
  nabostasjon — ingen historikk å hente (i motsetning til Frost). Data akkumuleres
  kun fremover. Henter alt i en boks (`DLAT`/`DLON`, ~flere km), sorterer på
  avstand og lagrer de `NETATMO_NEAREST` nærmeste (default 100, 0 = alle);
  `filter=true`. Grafana filtrerer så til visningsradius (300 m).
- **Netatmo-API-grenser** (dels udokumentert — verifisert/community):
  - Rate-limit: 500 kall/time per bruker (50/10s). Vår poller: ~48 kall/døgn,
    milevis under.
  - `getpublicdata` har et **udokumentert tak** på antall stasjoner per kall;
    store bokser returnerer et *utvalg*, ikke alt. Community-regel: rute på
    **~0,06°** er største som pålitelig gir alle stasjoner. Full by-dekning
    krever derfor tiling (rutenett av små bokser) — ikke gjort her, og gir
    uansett bare et dårligere Frost-duplikat på by-skala.
  - Refresh-token roteres (engangsbruk) — lagres i `app_state` [[datamodell]].
- **Statistikk-lærdom**: nabostasjoners feilplassering (sol på utedel) er en
  *systematisk, ensidig* skjevhet, ikke støy. Median slår snitt, men når sola
  rammer flertallet følger medianen dem opp — da er kalibrert Frost Hovin eneste
  pålitelige. Vær-dashbordet viser derfor Netatmo-median med p25–p75-bånd
  (bredde = usikkerhet) mot Frost Hovin som anker.

## Vedlikehold og livssyklus
- `deploy.sh` — ssh + git pull + `docker compose up -d --build` (via Tailscale).
- `update.sh` — ukentlig cron på VM-en (mandager 03:30 UTC): apt upgrade
  (dekker Docker+Tailscale), `compose pull` (Grafana/Postgres), prune,
  helsesjekk, auto-reboot ved kjerneoppdatering. Varsler status-topicet:
  stille ved ingen endring, lav prioritet ved oppdatering, høy ved feil.
- `destroy.sh [--full]` — avskjedsdump av db → `tailscale logout` →
  `terraform destroy` (+ tfstate-rg/NetworkWatcherRG med `--full`).
- Daglig hjertebank kl. 08 (`HEARTBEAT_HOUR`) på `-status`-topicet; uteblitt
  melding = noe nede.

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