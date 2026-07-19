// Værpoller mot MET/Frost-API-et (frost.met.no). Egen tjeneste, løst koblet:
// deler kun databasen med resten. Henter utetemperatur, globalstråling
// (= sol/sky-signalet), vindstyrke og nedbør fra nærmeste målestasjon én gang
// i halvtimen, og skriver dem som events med source='met'.
//
// Uten FROST_CLIENT_ID i .env sover tjenesten (ingen crash-loop) — legg inn
// ID-en og kjør `docker compose up -d` for å vekke den.
import { pool, waitForDb, insertEvent } from './db.js';
import { log } from './logger.js';

const CLIENT_ID = process.env.FROST_CLIENT_ID;
const STATION = process.env.MET_STATION_ID || 'SN18700'; // Oslo–Blindern
const INTERVAL_MS = 30 * 60 * 1000;
const FROST = 'https://frost.met.no';

// Frost-element → state_name i events-tabellen
const ELEMENTS = {
  'air_temperature': 'air_temperature',
  'wind_speed': 'wind_speed',
  'sum(precipitation_amount PT1H)': 'precipitation',
  'mean(surface_downwelling_shortwave_flux_in_air PT1H)': 'global_radiation',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const authHeader = { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:`).toString('base64')}` };

async function stationName() {
  try {
    const res = await fetch(`${FROST}/sources/v0.jsonld?ids=${STATION}`, { headers: authHeader });
    if (!res.ok) return `MET ${STATION}`;
    const body = await res.json();
    const name = body.data?.[0]?.name;
    return name ? `MET ${name}` : `MET ${STATION}`;
  } catch {
    return `MET ${STATION}`;
  }
}

async function fetchObservations() {
  // 12 timers vindu bakover: Frost-observasjoner kan komme med etterslep,
  // og unik-constrainten deduper overlappen gratis.
  const to = new Date();
  const from = new Date(to.getTime() - 12 * 3600 * 1000);
  const url =
    `${FROST}/observations/v0.jsonld` +
    `?sources=${STATION}` +
    `&referencetime=${from.toISOString()}/${to.toISOString()}` +
    `&elements=${encodeURIComponent(Object.keys(ELEMENTS).join(','))}`;

  const res = await fetch(url, { headers: authHeader });
  if (res.status === 412) {
    // Stasjonen mangler (noen av) elementene i perioden — ikke en feil
    return [];
  }
  if (!res.ok) {
    throw new Error(`Frost svarte HTTP ${res.status}`);
  }
  return (await res.json()).data ?? [];
}

async function main() {
  if (!CLIENT_ID) {
    log.info('FROST_CLIENT_ID ikke satt — met-polleren sover. Legg inn ID fra frost.met.no i .env og kjør docker compose up -d');
    setInterval(() => {}, 2 ** 30); // hold prosessen i live, stille
    return;
  }

  await waitForDb();
  const deviceName = await stationName();
  log.info('starter met-poller', { station: STATION, deviceName, intervalMinutes: INTERVAL_MS / 60000 });

  for (;;) {
    try {
      const observations = await fetchObservations();
      let inserted = 0;
      for (const entry of observations) {
        for (const obs of entry.observations ?? []) {
          const stateName = ELEMENTS[obs.elementId];
          if (!stateName || obs.value == null) continue;
          const wasNew = await insertEvent({
            deviceId: STATION,
            deviceName,
            feature: 'weather',
            stateName,
            value: obs.value,
            lastUpdated: entry.referenceTime,
            source: 'met',
          });
          if (wasNew) inserted++;
        }
      }
      log.debug('met-poll fullført', { rows: observations.length, inserted });
      if (inserted > 0) log.info('værdata lagret', { inserted });
    } catch (err) {
      log.warn('met-poll feilet', { error: String(err) });
    }
    await sleep(INTERVAL_MS);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    log.info('avslutter met-poller', { signal });
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  log.error('fatal feil i met-poller', { error: String(err?.stack ?? err) });
  process.exit(1);
});
