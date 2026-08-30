#!/bin/bash
set -e

# Runs once, on a fresh ClickHouse data directory only.
#
# Existing installations must apply the telemetry section by hand — see
# docs/observability/14-decisions.md D1/D3 for the statements and why.

clickhouse client -n <<-EOSQL
    CREATE DATABASE IF NOT EXISTS openpanel;

    -- Telemetry (gigapipe) lives on this same server in its own database.
    CREATE DATABASE IF NOT EXISTS ${CLICKHOUSE_TELEMETRY_DB:-openpanel_telemetry};

    -- gigapipe connects as its own user so that the settings profile and
    -- quota in clickhouse-telemetry-profile.xml actually bind to it. gigapipe
    -- sends no query settings of its own and cannot be configured to, so this
    -- user is the only place telemetry queries can be constrained.
    CREATE USER IF NOT EXISTS gigapipe
        IDENTIFIED BY '${CLICKHOUSE_TELEMETRY_PASSWORD:-gigapipe}'
        SETTINGS PROFILE 'telemetry';

    -- Scoped to the telemetry database only. gigapipe has no reason to read
    -- the analytics tables, and this is the boundary that says so.
    GRANT SELECT, INSERT, ALTER, CREATE, DROP, TRUNCATE, OPTIMIZE, SHOW
        ON ${CLICKHOUSE_TELEMETRY_DB:-openpanel_telemetry}.*
        TO gigapipe;

    -- Needed for gigapipe's own startup schema checks.
    GRANT SELECT ON system.* TO gigapipe;

    ALTER USER gigapipe SETTINGS PROFILE 'telemetry';
EOSQL
