#!/bin/sh
# Runs once, on first init of the data volume. Creates the database used by
# integration/concurrency tests so they never touch dev data.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE \"${POSTGRES_TEST_DB}\""
