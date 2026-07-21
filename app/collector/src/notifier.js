// Egen tjeneste (samme image, annen kommando): lytter på nye events via
// Postgres LISTEN/NOTIFY og sender push-varsler til ntfy for utvalgte
// hendelser. Kjører uavhengig av collectoren.
import pg from 'pg';
import { pool } from './db.js';
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
// Time på døgnet (Europe/Oslo, 0–23) for daglig hjertebank-varsel. Tom = av.
const HEARTBEAT_HOUR = parseInt(process.env.HEARTBEAT_HOUR ?? '8', 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returnerer null hvis eventen ikke skal varsles.
function ruleFor(evt) {
  const name = evt.device_name?.trim() || evt.device_id;

  if (evt.feature === 'alarm' && evt.state_name === 'alarm') {
    if (IGNORE_DEVICES.includes(name)) return null;
    const opened = evt.value === true;
    return {
      topic: 'dor',
      title: name,
      message: opened ? `${name} åpnet` : `${name} lukket`,
      priority: 'default',
      // 🚪 identifiserer at det er en dør; fargesirkelen viser tilstanden.
      // Farge skiller best på liten skjerm: 🔵 åpen (matcher blått i dashbordet)
      // vs 🟢 lukket (grønt). Solid farge er lesbart uansett størrelse.
      tags: opened ? 'door,large_blue_circle' : 'door,green_circle',
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

// JSON-publisering (POST til rot-URL-en) i stedet for header-basert: HTTP-
// headere er ASCII-only, så æøå i Title blir mojibake. I JSON-kroppen er alt
// UTF-8. NB: i JSON-modus er priority et tall og tags et array.
const PRIORITY_NUM = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

async function send(rule) {
  const res = await fetch(NTFY_BASE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic: `homely-${TOPIC_SECRET}-${rule.topic}`,
      title: rule.title,
      message: rule.message,
      priority: PRIORITY_NUM[rule.priority] ?? 3,
      tags: rule.tags.split(','),
    }),
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

// Daglig hjertebank: et lite statusvarsel hver morgen. Verdien ligger like mye
// i fraværet — uteblir meldingen, er noe galt (VM nede, collector død, ntfy
// utilgjengelig). Stillhet skal aldri kunne forveksles med «rolig hus».
async function sendHeartbeat() {
  const res = await pool.query(`
    SELECT count(*) AS antall,
           count(DISTINCT device_id) AS sensorer,
           to_char(max(last_updated) AT TIME ZONE 'Europe/Oslo', 'HH24:MI') AS siste
    FROM events
    WHERE last_updated > now() - interval '24 hours'
  `);
  const { antall, sensorer, siste } = res.rows[0];
  await send({
    topic: 'status',
    title: 'Homely-logger',
    message:
      `Alt i orden: ${antall} events fra ${sensorer} sensorer siste døgn` +
      (siste ? ` (siste ${siste})` : ''),
    priority: 'min',
    tags: 'white_check_mark',
  });
  log.info('hjertebank sendt', { antall, sensorer });
}

function startHeartbeat() {
  if (!Number.isInteger(HEARTBEAT_HOUR) || HEARTBEAT_HOUR < 0 || HEARTBEAT_HOUR > 23) {
    log.info('hjertebank deaktivert (HEARTBEAT_HOUR ikke satt til 0–23)');
    return;
  }
  let lastSentDate = null;
  setInterval(() => {
    // sv-SE gir ISO-aktig format: "2026-07-19 08:00:12"
    const oslo = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Oslo' });
    const [date, time] = oslo.split(' ');
    if (parseInt(time.slice(0, 2), 10) === HEARTBEAT_HOUR && lastSentDate !== date) {
      lastSentDate = date;
      sendHeartbeat().catch((err) => log.warn('hjertebank feilet', { error: String(err) }));
    }
  }, 60_000);
  log.info('hjertebank aktivert', { hourOslo: HEARTBEAT_HOUR });
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

  startHeartbeat();

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
