import { keyOf } from './ingest.js';
import { upsertDevice } from './db.js';
import { log } from './logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polling er en kjernefunksjon, ikke en reserve: websocketen streamer bare et
// delsett av features og faller ut innimellom. Hele hjem-tilstanden hentes
// jevnlig, og alt med nyere lastUpdated enn sist sett skrives inn.
export function startPoller({ client, state, ingest, locationId, intervalMs }) {
  (async () => {
    let delayMs = intervalMs;
    for (;;) {
      try {
        const home = await client.home(locationId);
        let checked = 0;
        let inserted = 0;

        for (const device of home.devices ?? []) {
          // Homely-appen tillater etterhengende mellomrom i navn — trim, ellers
          // feiler eksakt-match i Grafana og notifier-ignorelisten.
          const trimmet = device.name?.trim() || null;
          state.deviceNames.set(device.id, trimmet);
          // modelName gir sensortypen — lagres for type-riktig visning.
          upsertDevice({
            deviceId: device.id,
            name: trimmet,
            modelName: device.modelName,
            online: device.online,
          }).catch((err) => log.warn('kunne ikke oppdatere device-metadata', { error: String(err) }));

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
        delayMs = intervalMs;
      } catch (err) {
        // Ved rate-limit (429): trekk oss tilbake i stedet for å forverre det.
        // Ingen data går tapt — neste vellykkede poll henter alt via lastUpdated.
        if (err.status === 429) {
          delayMs = Math.min(delayMs * 2, 900_000);
          log.warn('poll rate-limitet, øker intervallet', {
            locationId,
            nextPollSeconds: delayMs / 1000,
          });
        } else {
          log.warn('poll feilet', { locationId, error: String(err) });
        }
      }

      await sleep(delayMs);
    }
  })();
}
