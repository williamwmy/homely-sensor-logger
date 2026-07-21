-- Kanonisk baseline for skjemaet. Eneste kilde: kjøres av migrate-tjenesten
-- både på ferske volumer (bygger alt fra bunn) og eksisterende (idempotente
-- guards gjør den til en no-op for det som allerede finnes).
CREATE TABLE IF NOT EXISTS events (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  device_id    text NOT NULL,
  device_name  text,
  feature      text NOT NULL,
  state_name   text NOT NULL,
  value        jsonb,
  last_updated timestamptz NOT NULL,
  source       text NOT NULL,
  CONSTRAINT events_change_unique UNIQUE (device_id, feature, state_name, last_updated)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_constraint
    WHERE conname = 'events_change_unique' AND conrelid = 'events'::regclass
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_change_unique
      UNIQUE (device_id, feature, state_name, last_updated);
  END IF;
END;
$$;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_source_check;
ALTER TABLE events ADD CONSTRAINT events_source_check
  CHECK (source IN ('websocket', 'poll', 'met', 'netatmo'));

CREATE INDEX IF NOT EXISTS events_device_name_time_idx ON events (device_name, last_updated DESC);
CREATE INDEX IF NOT EXISTS events_last_updated_idx ON events (last_updated DESC);

CREATE TABLE IF NOT EXISTS app_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  device_id  text PRIMARY KEY,
  name       text,
  model_name text,
  online     boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION current_name(dev_id text) RETURNS text AS $$
  SELECT COALESCE((SELECT name FROM devices WHERE device_id = dev_id), dev_id);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION human_time(ts timestamptz) RETURNS text AS $$
DECLARE
  d      date := (ts AT TIME ZONE 'Europe/Oslo')::date;
  i_dag  date := (now() AT TIME ZONE 'Europe/Oslo')::date;
  klokke text := to_char(ts AT TIME ZONE 'Europe/Oslo', 'HH24:MI');
BEGIN
  IF d = i_dag THEN
    RETURN 'i dag ' || klokke;
  ELSIF d = i_dag - 1 THEN
    RETURN 'i går ' || klokke;
  ELSIF d > i_dag - 7 THEN
    RETURN (ARRAY['søn','man','tir','ons','tor','fre','lør'])[extract(dow from d)::int + 1] || ' ' || klokke;
  ELSE
    RETURN to_char(ts AT TIME ZONE 'Europe/Oslo', 'DD.MM HH24:MI');
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;
