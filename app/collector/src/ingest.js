import { insertEvent } from './db.js';
import { log } from './logger.js';

export const keyOf = (deviceId, feature, stateName) => `${deviceId}|${feature}|${stateName}`;

export function createState() {
  return {
    // key → epoch-ms for siste kjente last_updated (fylles fra DB ved oppstart)
    lastSeen: new Map(),
    // deviceId → device_name (fylles fra REST-polling; websocket-events mangler navn)
    deviceNames: new Map(),
  };
}

// Felles innskrivingsfunksjon for både websocket og polling. Duplikater
// stoppes av unik-constrainten i databasen (ON CONFLICT DO NOTHING).
export function createIngest(state) {
  return async function ingest({ deviceId, feature, stateName, value, lastUpdated, source }) {
    if (lastUpdated == null) return false;
    const ts = new Date(lastUpdated);
    if (Number.isNaN(ts.getTime())) {
      log.warn('ugyldig lastUpdated, hopper over', { deviceId, feature, stateName, lastUpdated });
      return false;
    }

    try {
      const inserted = await insertEvent({
        deviceId,
        deviceName: state.deviceNames.get(deviceId) ?? null,
        feature,
        stateName,
        value,
        lastUpdated: ts,
        source,
      });
      state.lastSeen.set(keyOf(deviceId, feature, stateName), ts.getTime());
      if (inserted) {
        log.debug('event lagret', { deviceId, feature, stateName, value, source });
      }
      return inserted;
    } catch (err) {
      log.error('kunne ikke lagre event', {
        deviceId,
        feature,
        stateName,
        source,
        error: String(err),
      });
      return false;
    }
  };
}
