# Homely Sensor Logger

## Formål
Logg alle sensor-triggere fra Homely-alarmsystemet til en database, slik at hele
historikken bevares. Homely-appen viser bare siste aktivitet; dette prosjektet
bygger et permanent, spørrbart eventlager.

## Arkitektur
- Én liten Linux-VM (Ubuntu) i Azure, Norway East, på MSDN-kreditt.
- Docker Compose med to tjenester: `collector` og `db` (Postgres).
- All config i `.env`. Ingen hemmeligheter i koden eller i git.
- Bevisst flyttbart: samme compose skal kunne kjøre uendret på en Raspberry Pi
  eller VPS hvis Azure-kreditten forsvinner. Ingen Azure-spesifikke avhengigheter
  i selve appen.
- Infrastruktur som kode med Terraform (azurerm-provider).

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
- `location=<locationId>`

Event `device-state-changed` har `data` med `deviceId`, `gatewayId`,
`locationId`, `modelId`, `rootLocationId`, `changes[]`. Hver `change`:
`feature`, `stateName`, `value`, `lastUpdated`.

### VIKTIG: websocket alene er ikke nok
I flere oppsett streames bare et delsett av features (typisk temperatur og
nettverkstilkobling), ikke alle dør- og bevegelses-events. Derfor MÅ collectoren
også polle `GET /homely/home/<locationId>` jevnlig (default hvert 2. minutt),
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

## Konvensjoner
- Språk: Node (JavaScript eller TypeScript). `socket.io-client` for streaming
  (offisiell klient, håndterer EIO=4, handshake, ping/pong og reconnect),
  `undici`/`fetch` for REST, `pg` for Postgres.
  Homely-serveren er selv Socket.IO, så socket.io-client er hjemmebane og skjuler
  protokoll-detaljene. Den udokumenterte query-param-autentiseringen settes via
  `io(url, { query: { token: "Bearer <JWT>", location: "<locationId>" },
  transports: ["websocket"] })`.
- Websocket-lytter og polling-loop kjører parallelt (to async-funksjoner i samme
  prosess). Begge skriver til samme `events`-tabell via samme insert-funksjon.
- Merk: referanseimplementasjonen hansrune/homely-tools er i Python. Bruk den som
  språkuavhengig oppslagsverk for token-flyt, feltnavn og poll-logikk, men skriv
  selve collectoren i Node.
- Reconnect med backoff når websocketen dropper. Frisk token ved reconnect.
- Ingen hemmeligheter i git. `.env` i `.gitignore`, med `.env.example` som mal.
- Strukturert logging til stdout (Docker fanger det). Logg hver insert på
  debug-nivå, hver reconnect/feil på info/warn.
- `restart: unless-stopped` på begge containere.
- Postgres-data i et navngitt Docker-volume så det overlever restart.

## Referanser (de facto-dokumentasjon)
- `kongsvik.dev/posts/exploring-homely` — token-flyt, endepunkter,
  Socket.IO-detaljer (query-param-auth, EIO=4), og datastrukturer.
- `github.com/hansrune/homely-tools` — kjørende Python-impl med både polling og
  websocket. Nærmeste ting til en fasit.
- `github.com/kolaf/homelypy` — minimal REST-wrapper.