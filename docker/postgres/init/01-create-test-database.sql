-- Create isolated database for integration tests on initial data volume setup

\set test_db `echo "${POSTGRES_TEST_DB:-bhoomitrace_test}"`

SELECT format('CREATE DATABASE %I', :'test_db')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'test_db'
)\gexec

GRANT ALL PRIVILEGES ON DATABASE :"test_db" TO CURRENT_USER;
