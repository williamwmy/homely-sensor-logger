import { keyOf } from './ingest.js';
import { log } from './logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polling er en kjernefunksjon, ikke en reserve: websocketen streamer bare et
// delsett av features og faller ut innimellom. Hele hjem-tilstanden hentes
// jevnlig, og alt med nyere lastUpdated enn sist sett skrives inn.
export function startPoller({ client, state, ingest, locationId, intervalMs }) {
  (async () => {
    for (;;) {
      try {
        const home = await client.home(locationId);
        let checked = 0;
        let inserted = 0;

        for (const device of home.devices ?? []) {
          state.deviceNames.set(device.id, device.name);

          for (const [feature, featureData] of Object.entries(device.features ?? {})) {
            for (const [stateName, stateData] of Object.entries(featureData?.states ?? {})) {
              if (stateData?.lastUpdated == null) continue;
              checked++;

              const ts = new Date(stateData.lastUpdated).getTime();
              if (state.lastSeen.get(keyOf(device.id, feature, stateName)) === ts) continue;

              const wasNew = await ingest({
                deviceId: device.id,
                feature,
                stateName,
                value: stateData.value,
                lastUpdated: stateData.lastUpdated,
                source: 'poll',
              });
              if (wasNew) inserted++;
            }
          }
        }

        log.debug('poll fullført', { locationId, checked, inserted });
        if (inserted > 0) {
          log.info('poll fanget endringer websocketen bommet på', { locationId, inserted });
        }
      } catch (err) {
        log.warn('poll feilet', { locationId, error: String(err) });
      }

      await sleep(intervalMs);
    }
  })();
}
