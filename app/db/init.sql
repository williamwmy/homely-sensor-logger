-- Append-only eventlager for Homely-sensordata.
CREATE TABLE IF NOT EXISTS events (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  device_id    text        NOT NULL,
  device_name  text,
  feature      text        NOT NULL,
  state_name   text        NOT NULL,
  value        jsonb,
  last_updated timestamptz NOT NULL,
  source       text        NOT NULL CHECK (source IN ('websocket', 'poll', 'met')),

  -- Websocket og polling overlapper; samme endring skal bare lagres én gang.
  CONSTRAINT events_change_unique UNIQUE (device_id, feature, state_name, last_updated)
);

CREATE INDEX IF NOT EXISTS events_device_name_time_idx ON events (device_name, last_updated DESC);
CREATE INDEX IF NOT EXISTS events_last_updated_idx ON events (last_updated DESC);

-- Varsler notifier-tjenesten om hver ny rad via LISTEN/NOTIFY.
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('events_channel', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_notify ON events;
CREATE TRIGGER events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_event();
