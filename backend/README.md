# BhoomiTrace backend

Node.js 24 · TypeScript (strict) · Fastify · Drizzle ORM · PostgreSQL · Zod · Vitest

This document covers the Phase 1 foundation: the service skeleton, runtime
configuration, the PostgreSQL schema, and how to run the checks.

## Prerequisites

- **Node.js 24 LTS.** The version is pinned in `.mise.toml`
  (`mise install` inside `backend/`). Do not install Node globally.
- **Docker Desktop** (already required for the local database).
- PostgreSQL is **not** installed on the host; it runs in a container.

## First-time setup

```bash
# 1. Start PostgreSQL (from the repository root)
docker compose up -d

# 2. Install dependencies (from backend/)
cd backend
mise install                 # installs the pinned Node 24 toolchain
npm ci                       # installs from the committed lockfile

# 3. Create local configuration
cp .env.example .env         # local-only values; .env is git-ignored

# 4. Apply migrations and load synthetic demo data
npm run db:migrate
npm run db:seed
```

`docker compose up -d` publishes PostgreSQL on `127.0.0.1:5433` and creates two
databases: `bhoomitrace` (development) and `bhoomitrace_test` (integration
tests). Both are created from `docker/postgres/init/`.

## Commands

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | Start the API with reload. |
| `npm run build` | Compile to `dist/` with `tsc`. |
| `npm start` | Run the compiled server. |
| `npm run typecheck` | Type-check sources and tests without emitting. |
| `npm test` | Run unit **and** integration tests. |
| `npm run test:unit` | Unit tests only (no database required). |
| `npm run test:integration` | Integration tests (requires the Compose database). |
| `npm run db:generate` | Generate a new migration from schema changes. |
| `npm run db:migrate` | Apply pending migrations. |
| `npm run db:seed` | Load the synthetic demo dataset (idempotent). |

There is no lint step yet; correctness is enforced by TypeScript in `strict`
mode (plus `noUncheckedIndexedAccess`) and by the test suite.

## Endpoints

| Route | Purpose |
| ----- | ------- |
| `GET /health/live` | Process liveness. Does not touch the database. |
| `GET /health` | Readiness. Probes the database; `503` when it is unreachable. |

## Layout

```
src/
├── app.ts               Fastify construction, logging, redaction, errors
├── server.ts            Process bootstrap and graceful shutdown
├── config/              Environment loading and Zod validation
├── db/
│   ├── client.ts        Pooled client, health probe
│   ├── migrate.ts       Migration runner (library)
│   ├── migrate-cli.ts   npm run db:migrate
│   ├── seed.ts          Synthetic seed dataset (library)
│   ├── seed-cli.ts      npm run db:seed
│   └── schema/          Drizzle table definitions, one file per domain area
├── lib/rational.ts      Exact decimal-area and rational-share arithmetic
└── routes/health.ts     Health endpoints
drizzle/                 Generated SQL migrations (committed)
test/
├── unit/                Pure logic; no database
└── integration/         Runs against the *_test database
```

## Database notes

- **Areas** are `numeric(14, 4)` (decimals / শতাংশ). Never floating point.
- **Ownership shares** are stored as an exact rational pair
  (`share_numerator` / `share_denominator`) so `1/3` keeps its meaning.
- **Raw vs reviewed values** are separate columns: `recorded_value` is what was
  read, `reviewed_value` is only set once a reviewer corrects it. A check
  constraint enforces that `reviewed_value` appears only with the `corrected`
  state.
- **Confidence** is nullable and never invented.
- **`review_decisions` and `audit_events` are append-only**, enforced by a
  database trigger. Re-running a review inserts a new row; history is preserved.
- **`updated_at`** is maintained by a database trigger, not by application code.
- **Lineage links** carry their own certainty (`confirmed` / `illustrative` /
  `unverified`) and are `ON DELETE RESTRICT`, so history cannot be orphaned.

The SQL is committed under `drizzle/`; migrations are never edited after being
applied to a shared database.

## Synthetic data only

All seed data is invented for interface review. No real personal data,
government records, scrape results, OCR output, or model output is present.
BhoomiTrace does not determine legal ownership and does not issue legal
approval; discrepancies are findings for a human reviewer.

## Known issues

- `npm audit` reports 4 moderate advisories from `esbuild` packages pulled in
  transitively by `drizzle-kit` (a dev-only dependency). They affect the local
  migration tooling, not production code. The suggested remediation is a
  breaking downgrade of `drizzle-kit`, so it is deliberately not applied.
