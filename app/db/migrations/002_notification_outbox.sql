-- Varig kø for push-varsler. Hendelsen og køelementet opprettes i samme
-- transaksjon, slik at notifier-nedetid eller mistet LISTEN-forbindelse ikke
-- kan føre til tapte varsler.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id              bigserial PRIMARY KEY,
  event_id        bigint NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  processed_at    timestamptz,
  sent_at         timestamptz,
  last_error      text
);

CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
  ON notification_outbox (next_attempt_at, id)
  WHERE processed_at IS NULL;

-- NOTIFY er kun et raskt vekkesignal. Selve sannheten ligger i outbox-tabellen,
-- som notifier også leser ved oppstart og med jevne mellomrom.
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
  INSERT INTO notification_outbox (event_id)
  VALUES (NEW.id)
  ON CONFLICT (event_id) DO NOTHING;
  PERFORM pg_notify('events_channel', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_notify ON events;
CREATE TRIGGER events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_event();
