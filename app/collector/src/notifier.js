// Egen tjeneste (samme image, annen kommando): lytter på nye events via
// Postgres LISTEN/NOTIFY og sender push-varsler til ntfy for utvalgte
// hendelser. Kjører uavhengig av collectoren.
import pg from 'pg';
import { log } from './logger.js';

function required(name) {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`Mangler påkrevd miljøvariabel: ${name}\n`);
    process.exit(1);
  }
  return value;
}

const NTFY_BASE_URL = process.env.NTFY_BASE_URL ?? 'https://ntfy.sh';
const TOPIC_SECRET = required('NTFY_TOPIC_SECRET');
const IGNORE_DEVICES = (process.env.NOTIFY_IGNORE_DEVICES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_AGE_MS = parseInt(process.env.NOTIFY_MAX_AGE_SECONDS ?? '900', 10) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returnerer null hvis eventen ikke skal varsles.
function ruleFor(evt) {
  const name = evt.device_name?.trim() || evt.device_id;

  if (evt.feature === 'alarm' && evt.state_name === 'alarm') {
    if (IGNORE_DEVICES.includes(name)) return null;
    return {
      topic: 'dor',
      title: name,
      message: evt.value === true ? `${name} åpnet` : `${name} lukket`,
      priority: 'default',
      tags: 'door',
    };
  }

  if (evt.state_name === 'fire' && evt.value === true) {
    return {
      topic: 'sikkerhet',
      title: 'RØYK/BRANN',
      message: `Røykvarsler utløst: ${name}`,
      priority: 'urgent',
      tags: 'fire,rotating_light',
    };
  }

  if (evt.state_name === 'tamper' && evt.value === true) {
    return {
      topic: 'sikkerhet',
      title: 'Sabotasje',
      message: `Sensor åpnet eller fjernet: ${name}`,
      priority: 'high',
      tags: 'warning',
    };
  }

  if (evt.feature === 'battery' && ['low', 'defect'].includes(evt.state_name) && evt.value === true) {
    return {
      topic: 'batteri',
      title: 'Batteri',
      message: `${evt.state_name === 'defect' ? 'Batterifeil' : 'Lavt batteri'}: ${name}`,
      priority: 'low',
      tags: 'battery',
    };
  }

  return null;
}

async function send(rule) {
  const url = `${NTFY_BASE_URL}/homely-${TOPIC_SECRET}-${rule.topic}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Title: rule.title,
      Priority: rule.priority,
      Tags: rule.tags,
    },
    body: rule.message,
  });
  if (!res.ok) {
    throw new Error(`ntfy svarte HTTP ${res.status}`);
  }
}

async function handle(evt) {
  // Polling som tar igjen etterslep skriver events med gamle timestamps —
  // de skal i databasen, men ikke vekke noen midt på natta i etterkant.
  const ageMs = Date.now() - new Date(evt.last_updated).getTime();
  if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_MS) {
    log.debug('hopper over gammel event', { device: evt.device_name, ageSeconds: Math.round(ageMs / 1000) });
    return;
  }

  const rule = ruleFor(evt);
  if (!rule) return;

  try {
    await send(rule);
    log.info('push-varsel sendt', { topic: rule.topic, message: rule.message });
  } catch (err) {
    log.warn('kunne ikke sende push-varsel', { message: rule.message, error: String(err) });
  }
}

// Dedikert tilkobling (ikke pool) — LISTEN er knyttet til én sesjon.
// Mister vi den, kobler vi til igjen med backoff; ingen events går tapt i
// databasen uansett, vi mister bare varsler i nedetiden.
async function run() {
  log.info('starter notifier', {
    ntfyBaseUrl: NTFY_BASE_URL,
    ignoreDevices: IGNORE_DEVICES,
    maxAgeSeconds: MAX_AGE_MS / 1000,
  });

  let delayMs = 1000;
  for (;;) {
    const client = new pg.Client();
    try {
      await client.connect();
      await client.query('LISTEN events_channel');
      log.info('lytter på events_channel');
      delayMs = 1000;

      client.on('notification', (msg) => {
        try {
          handle(JSON.parse(msg.payload));
        } catch (err) {
          log.warn('ugyldig notify-payload', { error: String(err) });
        }
      });

      await new Promise((_, reject) => {
        client.on('error', reject);
        client.on('end', () => reject(new Error('tilkoblingen ble avsluttet')));
      });
    } catch (err) {
      log.warn('databasetilkoblingen røk, kobler til på nytt', {
        error: String(err),
        retryInSeconds: delayMs / 1000,
      });
    }
    try {
      await client.end();
    } catch {
      // allerede død
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 60_000);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log.info('avslutter notifier', { signal });
    process.exit(0);
  });
}

run().catch((err) => {
  log.error('fatal feil i notifier', { error: String(err?.stack ?? err) });
  process.exit(1);
});
