-- Runs once, on first initialisation of the PostgreSQL data volume.
--
-- Creates a separate database for integration tests so that test runs never
-- touch development data. The role created by the container entrypoint already
-- owns the cluster, but ownership is asserted explicitly for clarity.

\set test_db `echo "${POSTGRES_TEST_DB:-bhoomitrace_test}"`

SELECT format('CREATE DATABASE %I', :'test_db')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'test_db'
)\gexec

GRANT ALL PRIVILEGES ON DATABASE :"test_db" TO CURRENT_USER;
