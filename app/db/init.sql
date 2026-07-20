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
  source       text        NOT NULL CHECK (source IN ('websocket', 'poll', 'met', 'netatmo')),

  -- Websocket og polling overlapper; samme endring skal bare lagres én gang.
  CONSTRAINT events_change_unique UNIQUE (device_id, feature, state_name, last_updated)
);

CREATE INDEX IF NOT EXISTS events_device_name_time_idx ON events (device_name, last_updated DESC);
CREATE INDEX IF NOT EXISTS events_last_updated_idx ON events (last_updated DESC);

-- Liten nøkkel/verdi-tabell for tjeneste-tilstand som må overleve restart,
-- f.eks. Netatmos roterende refresh-token (engangsbruk — det nye tokenet fra
-- hver fornyelse må lagres, ellers ryker tilgangen ved neste omstart).
CREATE TABLE IF NOT EXISTS app_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enhets-metadata fra Homely (oppdateres ved hver polling). modelName gir
-- sensortypen ('Alarm Entry Sensor', 'Alarm Motion Sensor', 'Intelligent
-- Smoke Alarm' …) — brukes til type-riktig visning i stedet for å gjette på
-- navnet. `online` fanges også (nyttig for framtidig offline-varsling).
CREATE TABLE IF NOT EXISTS devices (
  device_id  text PRIMARY KEY,
  name       text,
  model_name text,
  online     boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Lesbar relativ tid for tabeller i Grafana: «i dag HH:MM», «i går HH:MM»,
-- ukedag denne uka, ellers dato. Alt i norsk lokaltid.
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
