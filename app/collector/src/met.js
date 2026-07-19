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
// Kommaseparert liste — hver måleserie hentes fra stasjonen som måler den
// best lokalt. Default: Hovin (temp/vind/nedbør, nær Ensjø) + Blindern
// (eneste i Oslo med globalstråling; skyer er uansett kilometer-skala).
const STATIONS = (process.env.MET_STATION_ID || 'SN18210,SN18700')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
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

async function stationNames() {
  const names = new Map(STATIONS.map((id) => [id, `MET ${id}`]));
  try {
    const res = await fetch(`${FROST}/sources/v0.jsonld?ids=${STATIONS.join(',')}`, {
      headers: authHeader,
    });
    if (res.ok) {
      for (const src of (await res.json()).data ?? []) {
        if (src.id && src.name) names.set(src.id, `MET ${src.name}`);
      }
    }
  } catch {
    // navnene er kosmetiske — fall tilbake til id
  }
  return names;
}

async function fetchObservations() {
  // 12 timers vindu bakover: Frost-observasjoner kan komme med etterslep,
  // og unik-constrainten deduper overlappen gratis.
  const to = new Date();
  const from = new Date(to.getTime() - 12 * 3600 * 1000);
  const url =
    `${FROST}/observations/v0.jsonld` +
    `?sources=${STATIONS.join(',')}` +
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
  const names = await stationNames();
  log.info('starter met-poller', {
    stations: Object.fromEntries(names),
    intervalMinutes: INTERVAL_MS / 60000,
  });

  for (;;) {
    try {
      const observations = await fetchObservations();
      let inserted = 0;
      for (const entry of observations) {
        // sourceId kommer som "SN18210:0" — suffikset er sensornivå
        const stationId = String(entry.sourceId ?? '').split(':')[0];
        for (const obs of entry.observations ?? []) {
          const stateName = ELEMENTS[obs.elementId];
          if (!stateName || obs.value == null) continue;
          const wasNew = await insertEvent({
            deviceId: stationId,
            deviceName: names.get(stationId) ?? `MET ${stationId}`,
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
