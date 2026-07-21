#!/bin/sh
# Kjører nummererte migreringer én gang per database. Fungerer både mot et
# eksisterende volum og etter at Postgres-entrypointet har initialisert et nytt.
set -eu

psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for migration in /migrations/*.sql; do
  [ -f "$migration" ] || continue
  filename=$(basename "$migration")

  if psql -v ON_ERROR_STOP=1 -Atqc \
    "SELECT 1 FROM schema_migrations WHERE filename = '$filename'" | grep -q 1; then
    echo "Migrering allerede kjørt: $filename"
    continue
  fi

  echo "Kjører migrering: $filename"
  {
    echo 'BEGIN;'
    cat "$migration"
    printf "\nINSERT INTO schema_migrations (filename) VALUES ('%s');\n" "$filename"
    echo 'COMMIT;'
  } | psql -v ON_ERROR_STOP=1
done

# Rollen kan ha manglet på eldre volumer. format(%L) sørger for korrekt SQL-
# quoting også når passordet inneholder apostrof eller andre spesialtegn.
psql -v ON_ERROR_STOP=1 -v grafana_password="$GRAFANA_DB_PASSWORD" -v database="$PGDATABASE" <<'SQL'
SELECT format('CREATE ROLE grafana_reader LOGIN PASSWORD %L', :'grafana_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grafana_reader') \gexec
SELECT format('ALTER ROLE grafana_reader PASSWORD %L', :'grafana_password') \gexec
GRANT CONNECT ON DATABASE :"database" TO grafana_reader;
GRANT SELECT ON events, devices TO grafana_reader;
SQL

echo "Databasemigreringer er oppdatert."
