# BhoomiTrace backend

Node.js 24 · TypeScript (strict) · Fastify · Drizzle ORM · PostgreSQL · Zod · Vitest

This document covers the Phase 1 foundation: the service skeleton, runtime
configuration, the PostgreSQL schema, and how to run the checks.

## Prerequisites

- **Node.js 24 LTS**, installed per-user with [mise](https://mise.jdx.dev). The
  exact version is pinned in `.mise.toml`. Do not install Node globally, via
  Homebrew, or via a global npm install.
- **Docker Desktop**, for the local database.
- PostgreSQL is **not** installed on the host; it runs in a container.

`mise` is installed under `~/.local/bin` and this repository deliberately does
**not** modify your shell startup files. That has one consequence worth being
explicit about:

> A bare `npm` command uses whatever Node happens to be on your `PATH`, which
> may not be 24. Every command in this README is therefore written to run through
> mise, so the pinned runtime is always used.

## First-time setup

```bash
# 1. Start PostgreSQL (from the repository root)
docker compose up -d

# 2. Put mise on PATH for this shell
export PATH="$HOME/.local/bin:$PATH"

# 3. Install the pinned Node 24 toolchain and dependencies (from backend/)
cd backend
mise trust                   # only if mise reports the config as untrusted
mise install                 # installs Node 24 from .mise.toml
mise exec -- npm ci          # installs exactly what the lockfile pins

# 4. Create local configuration
cp .env.example .env         # local-only values; .env is git-ignored

# 5. Apply migrations and load synthetic demo data
mise exec -- npm run db:migrate
mise exec -- npm run db:seed
```

If you would rather not change `PATH`, prefix each command with
`~/.local/bin/` instead — for example `~/.local/bin/mise exec -- npm ci`.

Optionally, to make mise permanent for your own shell, run
`echo 'eval "$(mise activate zsh)"' >> ~/.zshrc` yourself. That is a change to
your shell configuration, so it is left to you and is not done by this project.

`docker compose up -d` publishes PostgreSQL on **`127.0.0.1:5433` only** and
creates two databases: `bhoomitrace` (development) and `bhoomitrace_test`
(integration tests). Both come from `docker/postgres/init/`.

## Commands

Run these from `backend/` with `mise` on `PATH`. The `mise exec --` prefix is
what guarantees the pinned Node 24 runtime.

| Command | Purpose |
| ------- | ------- |
| `mise exec -- npm run dev` | Start the API with reload. |
| `mise exec -- npm run build` | Compile to `dist/` with `tsc`. |
| `mise exec -- npm start` | Run the compiled server. |
| `mise exec -- npm run typecheck` | Type-check sources and tests without emitting. |
| `mise exec -- npm test` | Run unit **and** integration tests. |
| `mise exec -- npm run test:unit` | Unit tests only (no database required). |
| `mise exec -- npm run test:integration` | Integration tests (requires the Compose database). |
| `mise exec -- npm run db:generate` | Generate a new migration from schema changes. |
| `mise exec -- npm run db:migrate` | Apply pending migrations. |
| `mise exec -- npm run db:seed` | Load the synthetic demo dataset (idempotent). |

`package.json` sets `engines.node` to `>=24 <25` and `.npmrc` enables
`engine-strict`, so installing or running under a different major fails fast
rather than producing a subtly different result.

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
│   ├── seed.ts          Synthetic seed dataset + fixture repair (library)
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
- **`updated_at`** is maintained by a database trigger, not by application code.

### Append-only history and deletion policy

`review_decisions` and `audit_events` are append-only, enforced by database
triggers that reject `UPDATE` and `DELETE`. Re-running a review inserts a new row;
history is preserved.

Because those triggers reject writes, a referential action that would *rewrite*
or *remove* one of their rows cannot be permitted — the two mechanisms would
contradict each other. The resulting policy:

- Every foreign key held by an append-only table is `ON DELETE RESTRICT`, and
  nothing references an append-only table with `CASCADE` or `SET NULL`. A
  decision's subject and its author cannot be deleted while the decision exists.
- Records that carry history are never hard-deleted. Accounts are deactivated via
  `users.status = 'suspended'`; parcels are retained. Hard deletion is reserved
  for records with no history.
- Owned attributes with no independent meaning (`parcel_dags`) cascade with their
  parent.
- Derived data a reviewer has not yet acted on (`extractions`, `findings`)
  cascades with its parcel. Once review history exists, that cascade is blocked
  by the `RESTRICT` keys, so history always wins and the delete is atomic —
  nothing is partially removed.
- `audit_events.entity_type` / `entity_id` are deliberately **not** foreign keys.
  An audit entry records what happened and must outlive the entity it describes.
- `parcel_lineage` uses `ON DELETE RESTRICT` too, so lineage can never be
  silently orphaned.

These behaviours are covered by `test/integration/deletion-policy.test.ts`.

### Migrations

The SQL is committed under `drizzle/`; migrations are never edited after being
applied to a shared database. `npm run db:seed` is idempotent: it inserts with
fixed identifiers, and it also performs one narrowly scoped repair so that a
database seeded before a fixture wording correction converges in place, without
resetting the volume. The repair is limited to the single fixed synthetic finding
id and only matches rows that still contain the superseded sentence, so it can
never overwrite an edited row.

## Synthetic data only

All seed data is invented for interface review. No real personal data,
government records, scrape results, OCR output, or model output is present.
BhoomiTrace does not determine legal ownership and does not issue legal
approval; discrepancies are findings for a human reviewer.

## Dependency notes

- **`@types/node` is pinned to the Node 24 line** (`^24.19.2`) to match the
  runtime. It is deduplicated across the whole tree.
- **`esbuild` override.** `drizzle-kit` (latest, 0.31.11) still depends on the
  deprecated `@esbuild-kit/esm-loader`, which pulls in `esbuild@0.18.x` — the
  version covered by GHSA-67mh-4wv8-2f99. There is no upstream fix. A targeted
  `overrides` entry forces `esbuild@^0.25.12` for `@esbuild-kit/core-utils` only,
  which removes all advisories (`npm audit` reports 0). Verified afterwards:
  `drizzle-kit generate` reports no schema drift, migrations apply, the build
  succeeds, and all tests pass.
  *Residual risk:* `@esbuild-kit/core-utils` is used only by drizzle-kit's
  development-time config loader. If a future esbuild change broke it, the effect
  would be a failure of `npm run db:generate`, not of production code or the
  shipped runtime. The override will be removed as soon as drizzle-kit drops the
  dependency.
- **Install scripts are not approved.** npm's install-script gating leaves the
  `esbuild` and `fsevents` postinstall scripts unapproved. No script was
  approved. The platform binaries come from the versioned optional dependencies,
  and `esbuild`, `tsx`, `vitest`, and `drizzle-kit` were each executed
  successfully in that state.
- **TypeScript** resolves to 7.0.2 (the current release of the `typescript`
  package), used with `strict` settings.
