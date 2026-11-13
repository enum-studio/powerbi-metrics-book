#!/usr/bin/env bash
# First start of the stack's Postgres: one login role per container, the app
# database and its extension. The official image runs the files in
# /docker-entrypoint-initdb.d once, as the superuser, on an empty data
# directory; a restart does not run them again.
#
# The server's own POSTGRES_DB must not be powerbi_metrics_book, since this
# script creates it.
#
# Passwords reach psql through \getenv, so none is on a command line or in the
# SQL text psql echoes when a statement fails.
set -euo pipefail

for name in MIGRATOR_PASSWORD API_RW_PASSWORD WORKER_RW_PASSWORD AUDIT_WRITER_PASSWORD; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is not set" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv migrator_password MIGRATOR_PASSWORD
\getenv api_rw_password API_RW_PASSWORD
\getenv worker_rw_password WORKER_RW_PASSWORD
\getenv audit_writer_password AUDIT_WRITER_PASSWORD

create role migrator login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'migrator_password';
create role api_rw login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'api_rw_password';
create role worker_rw login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'worker_rw_password';
create role audit_writer login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'audit_writer_password';

-- The migrator owns the database, so it owns every table the migrations make;
-- the other roles get only what src/db/grants.ts declares for them.
create database powerbi_metrics_book owner migrator;

-- public holds connect and temporary on a new database by default. Taking all
-- of it back means a role reaches the database only when named here. An owner
-- keeps every right on its own database.
revoke all on database powerbi_metrics_book from public;
grant connect on database powerbi_metrics_book to api_rw, worker_rw, audit_writer;
SQL

# Created by the superuser, since an extension needs one, and never by a
# migration. Postgres 15 and later no longer let public create in schema
# public; said again here so the rule does not rest on a default.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname powerbi_metrics_book <<'SQL'
create extension if not exists vector;
-- Trigram similarity, for the drafts queue's closest metric names.
create extension if not exists pg_trgm;
revoke create on schema public from public;
SQL
