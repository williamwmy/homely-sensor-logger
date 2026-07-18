import pg from 'pg';
import { log } from './logger.js';

// Tilkobling via PG*-miljøvariablene (satt i docker-compose.yml).
export const pool = new pg.Pool({ max: 5 });

export async function waitForDb(maxAttempts = 30) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      log.info('database tilkoblet');
      return;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      log.warn('venter på database', { attempt, error: String(err) });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const INSERT_SQL = `
  INSERT INTO events (device_id, device_name, feature, state_name, value, last_updated, source)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
  ON CONFLICT (device_id, feature, state_name, last_updated) DO NOTHING
`;

// Returnerer true hvis raden var ny (false = duplikat, allerede logget).
export async function insertEvent({ deviceId, deviceName, feature, stateName, value, lastUpdated, source }) {
  const res = await pool.query(INSERT_SQL, [
    deviceId,
    deviceName,
    feature,
    stateName,
    JSON.stringify(value ?? null),
    lastUpdated,
    source,
  ]);
  return res.rowCount > 0;
}

// Siste kjente endringstidspunkt per (device, feature, state), så en restart
// ikke behandler hele nå-tilstanden som nye events.
export async function loadLastSeen() {
  const res = await pool.query(`
    SELECT device_id, feature, state_name, max(last_updated) AS last_updated
    FROM events
    GROUP BY device_id, feature, state_name
  `);
  const lastSeen = new Map();
  for (const row of res.rows) {
    lastSeen.set(
      `${row.device_id}|${row.feature}|${row.state_name}`,
      row.last_updated.getTime()
    );
  }
  log.info('lastet siste kjente tilstand fra databasen', { keys: lastSeen.size });
  return lastSeen;
}
