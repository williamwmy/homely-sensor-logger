import { io } from 'socket.io-client';
import { log } from './logger.js';

// Homely autentiserer websocketen via query-parametere (udokumentert, men
// bekreftet oppførsel): token=Bearer <JWT> og location=<locationId>.
// socket.io-client håndterer EIO=4, handshake, ping/pong og reconnect med
// eksponentiell backoff.
export function startSocket({ client, state, ingest, apiBase, locationId }) {
  const socket = io(apiBase, {
    transports: ['websocket'],
    query: {
      location: locationId,
      token: `Bearer ${client.currentToken()}`,
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 60_000,
    randomizationFactor: 0.5,
  });

  // Tokenet i handshaken kan ha utløpt når vi mister forbindelsen; bytt det
  // ut med et friskt før hvert reconnect-forsøk.
  socket.io.on('reconnect_attempt', (attempt) => {
    socket.io.opts.query = {
      ...socket.io.opts.query,
      token: `Bearer ${client.currentToken()}`,
    };
    log.info('websocket reconnect-forsøk', { locationId, attempt });
  });

  socket.on('connect', () => log.info('websocket tilkoblet', { locationId }));
  socket.on('disconnect', (reason) => log.warn('websocket frakoblet', { locationId, reason }));
  socket.on('connect_error', (err) =>
    log.warn('websocket-tilkoblingsfeil', { locationId, error: String(err?.message ?? err) })
  );

  const handleStateChange = (payload) => {
    // Kan komme som {type, data} via "event" eller som data direkte via
    // "device-state-changed" — normaliser begge.
    const type = payload?.type;
    if (type && type !== 'device-state-changed') {
      log.debug('ignorerer event-type', { locationId, type });
      return;
    }
    const data = payload?.data ?? payload;
    if (!data?.deviceId || !Array.isArray(data.changes)) return;

    for (const change of data.changes) {
      ingest({
        deviceId: data.deviceId,
        feature: change.feature,
        stateName: change.stateName,
        value: change.value,
        lastUpdated: change.lastUpdated,
        source: 'websocket',
      });
    }
  };

  socket.on('event', handleStateChange);
  socket.on('device-state-changed', handleStateChange);

  return socket;
}
