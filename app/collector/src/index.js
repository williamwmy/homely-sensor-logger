import { config } from './config.js';
import { log } from './logger.js';
import { HomelyClient } from './homely.js';
import { pool, waitForDb, loadLastSeen } from './db.js';
import { createState, createIngest } from './ingest.js';
import { startPoller } from './poller.js';
import { startSocket } from './socket.js';

async function main() {
  log.info('starter homely-collector', { pollIntervalSeconds: config.pollIntervalMs / 1000 });

  await waitForDb();

  const client = new HomelyClient(config);
  await client.start();

  const state = createState();
  state.lastSeen = await loadLastSeen();
  const ingest = createIngest(state);

  const locations = await client.locations();
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('fant ingen locations på Homely-kontoen');
  }

  for (const location of locations) {
    log.info('starter innsamling for location', {
      locationId: location.locationId,
      name: location.name,
    });
    startPoller({
      client,
      state,
      ingest,
      locationId: location.locationId,
      intervalMs: config.pollIntervalMs,
    });
    startSocket({
      client,
      state,
      ingest,
      apiBase: config.apiBase,
      locationId: location.locationId,
    });
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    log.info('avslutter', { signal });
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  log.error('fatal feil ved oppstart', { error: String(err?.stack ?? err) });
  process.exit(1);
});
