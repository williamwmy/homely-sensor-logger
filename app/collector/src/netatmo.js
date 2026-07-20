// Netatmo-poller. Henter utetemperatur fra offentlig-delte nabostasjoner rundt
// et senterpunkt (getpublicdata) — hyperlokalt supplement til MET-stasjonene.
// Egen tjeneste, samme løse kobling som met/notifier: deler kun databasen.
//
// Uten NETATMO_CLIENT_ID/SECRET/REFRESH_TOKEN sover tjenesten (ingen crash).
import { pool, waitForDb, insertEvent } from './db.js';
import { log } from './logger.js';

const CLIENT_ID = process.env.NETATMO_CLIENT_ID;
const CLIENT_SECRET = process.env.NETATMO_CLIENT_SECRET;
const ENV_REFRESH_TOKEN = process.env.NETATMO_REFRESH_TOKEN;
const LAT = parseFloat(process.env.NETATMO_LAT ?? '59.914');
const LON = parseFloat(process.env.NETATMO_LON ?? '10.785');
// Halv boks-bredde i grader. ~1,5 km: bredde nord/sør 0,0135°, øst/vest 0,027°
// (lengdegrader er ~halvparten så lange som breddegrader på 60°N).
const DLAT = 0.0135;
const DLON = 0.027;
// Hvor mange av stasjonene i boksen som lagres. 0 = alle (anbefalt — samme
// API-kall uansett, og Netatmo kan ikke backfilles, så vi hamstrer rådata).
const NEAREST = parseInt(process.env.NETATMO_NEAREST ?? '0', 10);
const INTERVAL_MS = 30 * 60 * 1000;
const API = 'https://api.netatmo.com';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Token: refresh_token roteres av Netatmo, så det lagres i app_state ---

async function loadRefreshToken() {
  const res = await pool.query(`SELECT value FROM app_state WHERE key = 'netatmo_refresh_token'`);
  return res.rows[0]?.value || ENV_REFRESH_TOKEN;
}

async function saveRefreshToken(token) {
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('netatmo_refresh_token', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [token]
  );
}

let accessToken = null;
let expiresAt = 0;
let refreshToken = null;

async function doRefresh(token) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`token-refresh feilet: HTTP ${res.status} ${JSON.stringify(body)}`);
    err.invalidGrant = body.error === 'invalid_grant';
    throw err;
  }
  return body; // { access_token, refresh_token, expires_in }
}

async function ensureToken() {
  if (accessToken && Date.now() < expiresAt - 60_000) return;
  try {
    const body = await doRefresh(refreshToken);
    accessToken = body.access_token;
    refreshToken = body.refresh_token;
    expiresAt = Date.now() + body.expires_in * 1000;
    await saveRefreshToken(refreshToken);
    log.debug('netatmo access-token fornyet');
  } catch (err) {
    // Lagret token kan være foreldet hvis brukeren har generert nytt i portalen
    // og oppdatert .env — fall tilbake til env-tokenet én gang.
    if (err.invalidGrant && refreshToken !== ENV_REFRESH_TOKEN) {
      log.warn('lagret refresh-token avvist, prøver token fra .env');
      refreshToken = ENV_REFRESH_TOKEN;
      return ensureToken();
    }
    throw err;
  }
}

// --- getpublicdata ---

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

async function fetchPublicStations() {
  await ensureToken();
  const params = new URLSearchParams({
    lat_ne: String(LAT + DLAT),
    lon_ne: String(LON + DLON),
    lat_sw: String(LAT - DLAT),
    lon_sw: String(LON - DLON),
    required_data: 'temperature',
    filter: 'true', // Netatmos egen kvalitetsfiltrering av åpenbart feilplasserte stasjoner
  });
  const res = await fetch(`${API}/api/getpublicdata?${params}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`getpublicdata feilet: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.body ?? [];
}

// Plukk ut temperatur + tidsstempel fra en stasjons measures-objekt.
function extractTemp(station) {
  for (const module of Object.values(station.measures ?? {})) {
    const types = module.type;
    if (!Array.isArray(types) || !types.includes('temperature') || !module.res) continue;
    const tIdx = types.indexOf('temperature');
    const [ts, values] = Object.entries(module.res)[0] ?? [];
    if (ts == null || !Array.isArray(values)) continue;
    return { temp: values[tIdx], ts: new Date(parseInt(ts, 10) * 1000) };
  }
  return null;
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !ENV_REFRESH_TOKEN) {
    log.info('Netatmo-credentials ikke satt — polleren sover. Fyll inn i .env og kjør docker compose up -d');
    setInterval(() => {}, 2 ** 30);
    return;
  }

  await waitForDb();
  refreshToken = await loadRefreshToken();
  log.info('starter netatmo-poller', { senter: [LAT, LON], nærmeste: NEAREST });

  for (;;) {
    try {
      const stations = await fetchPublicStations();

      // Ranger etter avstand fra senter. NEAREST=0 → behold alle i boksen;
      // ellers de N nærmeste. (Filtrering til visningsradius skjer i Grafana.)
      const sorted = stations
        .map((s) => {
          const [lon, lat] = s.place?.location ?? [];
          const t = extractTemp(s);
          if (lat == null || !t || t.temp == null) return null;
          return { id: s._id, dist: distanceM(LAT, LON, lat, lon), ...t, city: s.place?.city };
        })
        .filter(Boolean)
        .sort((a, b) => a.dist - b.dist);
      const ranked = NEAREST > 0 ? sorted.slice(0, NEAREST) : sorted;

      let inserted = 0;
      for (const st of ranked) {
        const wasNew = await insertEvent({
          deviceId: `netatmo-${st.id}`,
          deviceName: `Netatmo ${st.dist}m${st.city ? ' ' + st.city : ''}`,
          feature: 'weather',
          stateName: 'air_temperature',
          value: st.temp,
          lastUpdated: st.ts,
          source: 'netatmo',
        });
        if (wasNew) inserted++;
      }
      log.debug('netatmo-poll fullført', { stasjoner: ranked.length, inserted });
      if (inserted > 0) log.info('netatmo-værdata lagret', { stasjoner: ranked.length, inserted });
    } catch (err) {
      log.warn('netatmo-poll feilet', { error: String(err) });
    }
    await sleep(INTERVAL_MS);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    log.info('avslutter netatmo-poller', { signal });
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  log.error('fatal feil i netatmo-poller', { error: String(err?.stack ?? err) });
  process.exit(1);
});
