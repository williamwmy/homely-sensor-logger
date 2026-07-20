#!/bin/bash
# Kjøres av postgres-entrypointet ved førstegangs init (etter init.sql,
# alfabetisk rekkefølge). Egen lesebruker for Grafana — dashboards trenger
# aldri skrivetilgang.
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE grafana_reader LOGIN PASSWORD '${GRAFANA_DB_PASSWORD}';
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO grafana_reader;
  GRANT SELECT ON events TO grafana_reader;
  GRANT SELECT ON devices TO grafana_reader;
EOSQL
