<div align="center">

<img src="frontend/public/favicon.svg" alt="BhoomiTrace" width="120" height="120" />

# BhoomiTrace

### AI-assisted land-record verification and parcel-lineage platform

BhoomiTrace extracts values from land records with source links, keeps raw and
reviewed values separate, tracks parcel lineage (split / merge / renumbering),
reconciles areas and shares, and surfaces explainable findings with a full review
and audit trail.

**Track:** LandTech 2026 &nbsp;·&nbsp; **Challenge:** AI-assisted land-record verification

### 🌐 [Live Demo — devtree.online](https://devtree.online/)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-devtree.online-2ea44f?style=flat-square)](https://devtree.online/)
[![CI](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml)
[![Backend image](https://img.shields.io/badge/image-bhoomitrace--backend-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/mosabbir-maruf/packages/container/bhoomitrace-backend)
[![Frontend image](https://img.shields.io/badge/image-bhoomitrace--frontend-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/mosabbir-maruf/packages/container/bhoomitrace-frontend)
[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639?style=flat-square)](LICENSE)

[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/)
[![Tailwind CSS 4](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)

</div>

---

## Contents

- [What BhoomiTrace is](#what-bhoomitrace-is)
- [What it is not](#what-it-is-not)
- [Demo limitations](#demo-limitations)
- [Run it locally](#run-it-locally)
- [Run everything in Docker](#run-everything-in-docker)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Environment variables](#environment-variables)
- [Testing](#testing)
- [CI/CD and container images](#cicd-and-container-images)
- [Production readiness](#production-readiness)
- [Documentation map](#documentation-map)
- [Known limitations](#known-limitations)
- [License](#license)

---

## What BhoomiTrace is

BhoomiTrace is an AI-assisted **land-record verification and parcel-lineage**
platform. It reads land records, keeps the machine-extracted value separate from
the human-reviewed value, and links each value back to the document it came
from.

It then:

- **tracks parcel lineage** across survey generations (CS, SA, RS, BS), including
  splits, merges, and renumbering;
- **reconciles** recorded areas and ownership shares against the arithmetic the
  records imply;
- **raises explainable findings** — each one a named rule, the inputs it used, and
  the result — for a human reviewer to accept or reject;
- **keeps an append-only audit trail** of every decision, with the actor, the
  reason, and the version they acted on.

The workflow is built for a land office in Bangladesh: citizen-facing record
inspection and application tracking in Bengali and English, and a reviewer desk
for discrepancies.

## What it is not

These are deliberate boundaries, not missing features:

- It does **not** determine legal ownership.
- It does **not** issue official legal approval.
- It does **not** allege fraud. A finding is an administrative discrepancy for a
  person to resolve, not an accusation.
- It is **not** a government system, and it holds **no real land records**.
- It is **not** a legally authoritative source of title or survey data.

## Demo limitations

Read this before judging the output — it is the honest scope of what runs:

- **All data is synthetic.** The seed dataset is generated for demonstration;
  every parcel, person, khatian, and document is invented.
- **No live AI call is made by default.** `EXTRACTION_PROVIDER=mock` is
  deterministic, offline, and needs no credentials. The Gemini and Groq providers
  exist in the codebase but are **never exercised by default** and are not part of
  any verified test run.
- **There is no OCR.** Documents are stored and their metadata is captured;
  values are not read off scanned images by an OCR engine.
- **Extraction review is a prototype.** The interactive extraction-review desk
  refuses to record a decision in live mode rather than post a fabricated one.
- **Documents are not yet linked to a specific application**, so no screen claims
  a file belongs to a filing it cannot prove it belongs to.
- **No account lockout.** Failed logins are rate limited per address, not locked
  per account.
- **The hosted demo is a single-instance deployment.** If
  [devtree.online](https://devtree.online/) is not responding, the
  [local run](#run-it-locally) below starts the same stack on your own machine.

For the full list, see [Known limitations](#known-limitations).

## Run it locally

Recommended for development: the API, the worker, and the frontend all run on your
machine with hot reload, and only PostgreSQL runs in a container.

### Prerequisites

- **Node.js 24**, installed per-user with [mise](https://mise.jdx.dev). The pinned
  version lives in `backend/.mise.toml`, and `backend/.npmrc` sets `engine-strict`,
  so a different major fails fast instead of behaving subtly differently.
- **pnpm 9** for the frontend — the lockfile is `pnpm-lock.yaml`.
- **Docker**, for the database container only.

### 1. Start the database

```bash
# from the repository root: the database only
docker compose up -d postgres
docker compose ps postgres     # wait for "healthy"
```

Use this instead of a plain `docker compose up` for local development. A plain
`up` also starts the containerised API on `127.0.0.1:3000`, and the host API below
would then fail to bind that port.

### 2. Backend: install, migrate, seed

```bash
export PATH="$HOME/.local/bin:$PATH"   # put mise on PATH for this shell

cd backend
mise trust                             # only if mise reports the config as untrusted
mise install                           # installs the pinned Node 24
mise exec -- npm ci                    # exactly what the lockfile pins
cp .env.example .env                   # local-only values; .env is git-ignored
mise exec -- npm run db:migrate        # apply migrations
mise exec -- npm run db:seed           # load the synthetic demo dataset
```

`backend/.env.example` already points at the container database on
`127.0.0.1:5433`, so nothing needs editing. If you would rather not change `PATH`,
prefix each command with `~/.local/bin/` — for example
`~/.local/bin/mise exec -- npm ci`.

### 3. Backend: start the API and the worker

These are two separate processes. In one terminal:

```bash
cd backend
mise exec -- npm run dev       # API with reload on http://127.0.0.1:3000
```

In a second terminal:

```bash
cd backend
mise exec -- npm run worker    # background extraction worker
```

### 4. Create a reviewer or admin account

There is deliberately no HTTP route, request field, or environment variable that
can grant a privileged role — privilege would otherwise be one bug away from being
self-assigned. Provision an account out of band:

```bash
cd backend
mise exec -- npm run db:admin -- \
  --email reviewer@example.test --role reviewer --name "Demo Reviewer"
```

Omit `--password` and a strong one is generated and printed once. It is never
written to a log or a file, and only its Argon2id hash reaches the database.

### 5. Frontend: start the dev server

```bash
cd frontend
pnpm install
pnpm run dev        # http://localhost:5173
```

Vite proxies `/api` to `http://localhost:3000`, so the browser sees a single origin
and session cookies behave as they would behind a proxy.

### 6. Open it

| What | URL | Notes |
| ---- | --- | ----- |
| **Web app** | <http://localhost:5173> | Vite dev server with hot reload |
| API | <http://127.0.0.1:3000> | `/health`, `/health/live` |
| **API reference** | <http://127.0.0.1:3000/docs> | Swagger UI generated from the route schemas |
| PostgreSQL | `127.0.0.1:5433` | the `postgres` container |

### 7. Stop

Stop the API, worker, and Vite dev server with `Ctrl-C`, then:

```bash
docker compose stop postgres     # the database keeps its named volume
```

The `bhoomitrace-postgres-data` volume survives, so database rows are still there
next time. **Never** run `docker compose down -v`, and never prune volumes: that
deletes the database and every uploaded file.

---

## Run everything in Docker

The whole stack in containers, with no host Node.js or pnpm install. This builds
both images **from source**, so it does not depend on GHCR images being available.

### Prerequisites

- **Docker** with the **Compose v2** plugin — the `docker compose` command, not the
  legacy `docker-compose` script. Verify with:
  ```bash
  docker compose version
  ```
- **Git**.
- Free **ports 3000**, **5173**, and **5433** on the loopback interface, and enough
  disk for two images (the Node-based backend image is the larger of the two).

### 1. Clone and start

```bash
git clone https://github.com/mosabbir-maruf/BhoomiTrace.git
cd BhoomiTrace

# Optional: every value already has a safe local default in docker-compose.yml
cp .env.example .env

docker compose up -d --build
```

`--build` compiles both images locally: the backend from `backend/Dockerfile`
(TypeScript → `dist/`), the frontend from `frontend/Dockerfile` (Vite build served
by unprivileged nginx). The first run takes a few minutes; later runs reuse the
layer cache.

Startup order is enforced by Compose, not assumed: `postgres` becomes healthy →
`migrate` runs once and exits 0 → `api` and `worker` start (they wait on
`migrate: service_completed_successfully`).

### 2. Check that it started

```bash
# postgres should be "healthy", migrate "exited (0)", the rest "running"/"healthy"
docker compose ps

# readiness: pings PostgreSQL, returns 503 if the database is down
curl -sS http://127.0.0.1:3000/health

# liveness: never touches the database
curl -sS http://127.0.0.1:3000/health/live
```

`/health` returning `"status":"ok"` with `"database":{"status":"up"}` means the API
and its database are both up. If `migrate` did not exit 0, the API and worker
intentionally do not start — check `docker compose logs migrate`.

### 3. Open it

| What | URL | Notes |
| ---- | --- | ----- |
| **Web app** | <http://127.0.0.1:5173> | React SPA served by nginx; proxies `/api/` to the API |
| API | <http://127.0.0.1:3000> | `/health`, `/health/live` |
| **API reference** | <http://127.0.0.1:3000/docs> | Swagger UI generated from the route schemas |
| PostgreSQL | `127.0.0.1:5433` | containers reach it as `postgres:5432` |

All published ports are bound to the **loopback interface only**, so the stack is
not reachable from another machine on your network.

> The API docs at `/docs` are served directly by the API, not proxied through the
> frontend. Open them on port 3000, not 5173.

### 4. Load the synthetic demo data

The migration job creates the schema but seeds nothing. Load the demo dataset
(idempotent — running it twice is safe):

```bash
docker compose exec api node dist/db/seed-cli.js
```

It prints a summary of what it inserted. The seed **refuses to run** when
`NODE_ENV=production`, which is why the local stack sets `development`.

### 5. Create a reviewer or admin account

There is deliberately no HTTP route, request field, or environment variable that
can grant a privileged role — privilege is one bug away from being self-assigned
otherwise. Provision an account out of band:

```bash
# Omit --password and a strong one is generated and printed once.
docker compose exec api node dist/cli/bootstrap-account.js \
  --email reviewer@example.com --role reviewer --name "Demo Reviewer"
```

Copy the printed password immediately; it is never written to a log or a file, and
only its Argon2id hash reaches the database. Re-running the command for the same
address does not silently replace the password (pass `--reset-password` to do so
deliberately).

### 6. Logs

```bash
docker compose logs -f api        # follow the API
docker compose logs -f worker     # follow the background worker
docker compose logs --tail=50 migrate   # the migration run
docker compose ps                 # service state and health
```

Container logs redact the database password
(`postgres://bhoomitrace:***@postgres:5432/bhoomitrace`).

### 7. Stop

```bash
docker compose down            # stop everything, KEEPING both named volumes
docker compose stop api worker # or stop just these, leaving the database up
docker compose start api worker
```

`docker compose down` preserves the `bhoomitrace-postgres-data` and
`bhoomitrace-backend-uploads` volumes, so database rows and uploaded evidence
survive a restart.

> **Never** run `docker compose down -v`, and never prune volumes. That deletes the
> database and every uploaded file.

---

## Architecture

```
                         your browser
                              |
                    http://127.0.0.1:5173
                              |
                    +---------v----------+
                    |     frontend       |  React 19 SPA (Vite build)
                    |  unprivileged nginx|  serves static files,
                    |      :8080         |  proxies /api/ -> api:3000
                    +---------+----------+
                              |
                    +---------v----------+        +------------------+
                    |        api         |        |      worker      |
                    |  Fastify, :3000    |        |  separate process|
                    |  /api/v1, /health  |        |  claims queued   |
                    |  /docs (Swagger)   |        |  jobs in Postgres|
                    +----+---------+-----+        +--------+---------+
                         |         |                     |
             writes/reads|         |      reads uploads  |
                         |         +----------+          |
                    +----v--------------------------v---------+
                    |              postgres 17                 |
                    |   data + job queue + audit trail         |
                    |   volume bhoomitrace-postgres-data       |
                    +------------------------------------------+

                    uploads volume bhoomitrace-backend-uploads
                    (shared by api and worker at /data/uploads)

                    migrate: one-shot job. Runs before api and worker.
```

| Component | Technology | Role |
| --------- | ---------- | ---- |
| **frontend** | React 19, Vite 8, Tailwind CSS v4, TypeScript | Citizen dashboard, land-record inspection, application tracking, reviewer desk. Served as a static build by unprivileged nginx, which reverse-proxies `/api/` so the browser sees one origin and cookies work without CORS. |
| **api** | Fastify 5, Zod, Drizzle ORM, TypeScript | Versioned REST surface under `/api/v1`, cookie sessions plus CSRF token, rate limiting, uploads, deterministic validation, findings, review, and the audit trail. Also serves `/health`, `/health/live`, and Swagger UI at `/docs`. |
| **postgres** | PostgreSQL 17 | Single source of truth: records, documents metadata, jobs, findings, and the append-only audit log. Acts as the job queue, so no extra broker is needed. |
| **worker** | Node 24, separate process | Claims queued jobs (`SELECT ... FOR UPDATE SKIP LOCKED` with a lease), calls the configured extraction provider, and writes results back. Has no HTTP surface at all. |
| **migrate** | Drizzle migrations | One-shot job (`node dist/db/migrate-cli.js`). Applies every pending migration, records it, and exits. The API and worker never migrate, so scaling them cannot produce two migrators. |

The frontend and API share one origin **only** in the composed stack. Run the Vite
dev server on the host instead and requests are cross-origin, which is what
`CORS_ALLOWED_ORIGINS` exists for.

---

## Repository layout

```

.
├── .env.example        Local Compose environment template (safe defaults, no real secrets)
├── .github/
│   ├── scripts/    GHCR retention logic, a mock registry server, and their tests
│   └── workflows/
│       ├── ci.yml                     Typecheck, backend tests, frontend checks, deploy tests, image build + smoke
│       ├── publish-image.yml          Publishes both images to GHCR on main and version tags
│       └── ghcr-retention-report.yml  Report-only package audit (never deletes)
├── .gitignore
├── LICENSE             MIT
├── README.md           This runbook
├── docker-compose.yml  Local stack: postgres, migrate, api, worker, frontend
├── docker/
│   └── postgres/init/01-create-test-database.sql  Creates the integration-test database on first start
├── backend/            Fastify API, background worker, and operator CLIs
│   ├── Dockerfile           Multi-stage image: build -> production deps -> runtime (non-root, uid 1000)
│   ├── .env.example         Backend env template for running on the host with mise
│   ├── .mise.toml           Pins Node 24
│   ├── .npmrc               engine-strict, so a wrong Node major fails fast
│   ├── package.json         Scripts and dependencies
│   ├── tsconfig.json        Type-check config (sources + tests)
│   ├── tsconfig.build.json  Emit config (src -> dist)
│   ├── vitest.config.ts     Unit and integration test config
│   ├── drizzle.config.ts    drizzle-kit config for migration generation
│   ├── drizzle/             Forward-only SQL migrations 0000-0011 plus snapshots
│   ├── src/
│   │   ├── server.ts         API entry point (the `api` service command)
│   │   ├── app.ts            Fastify assembly: plugins, hooks, routes, /docs
│   │   ├── routes/health.ts  `/health` (readiness) and `/health/live` (liveness)
│   │   ├── config/           Environment parsing, constants, logging, .env loading
│   │   ├── db/               Pool, migrations, synthetic seed, schema definitions
│   │   ├── http/             Routes, request schemas, auth context, cookies, errors
│   │   ├── lib/              Shared primitives: errors, pagination, hashing, redaction
│   │   ├── services/         Domain logic: auth, documents, review, audit, jobs, lineage
│   │   ├── extraction/       Provider registry: offline mock, Gemini, Groq
│   │   ├── validation/       Deterministic rule engine
│   │   ├── worker/           Background extraction worker (the `worker` service command)
│   │   └── cli/              Out-of-band operator commands (account bootstrap)
│   └── test/                unit/ and integration/ suites
├── frontend/           React 19 single-page app
│   ├── Dockerfile            Vite build served by unprivileged nginx (uid 101, port 8080)
│   ├── nginx/default.conf    SPA history fallback + `/api/` reverse proxy
│   ├── index.html            SPA host document
│   ├── package.json          Scripts and dependencies
│   ├── vite.config.ts        Dev server, `/api` proxy target, build settings
│   ├── playwright.config.ts  Browser end-to-end configuration
│   ├── public/               Favicon set, Bengali fonts, robots.txt, sitemap.xml, og-image
│   ├── src/
│   │   ├── main.tsx     Browser bootstrap
│   │   ├── App.tsx      Route table
│   │   ├── components/  App shell, navigation, shared UI primitives
│   │   ├── features/    auth, citizen, reviewer, evidence, public screens
│   │   ├── hooks/       Routing, async data loading, per-route SEO
│   │   ├── lib/         API client (`lib/api/`) and formatting helpers
│   │   ├── config/      Navigation and route metadata
│   │   └── mocks/       Offline demo data provider (used only in explicit demo mode)
│   └── tests/                Contract tests and Playwright e2e specs
└── deploy/             Single-host production baseline (see deploy/README.md)
    ├── README.md                The deployment runbook
    ├── docker-compose.prod.yml  Standalone production stack (pulls immutable images; never builds)
    ├── env/                     stack.env.example and secrets.env.example templates
    ├── edge/                    nginx TLS edge proxy - the only service that publishes ports
    ├── scripts/                 preflight, deploy, rollback, backup, restore, TLS, health
    ├── systemd/                 Timers for backups, health checks, and certificate renewal
    ├── cloudwatch/              Agent configuration and alarms.md (commands + proof steps)
    └── tests/                   Production config and script test suite
```

---

## Environment variables

The local Compose stack reads the root `.env.example`. Copy it to `.env` to change
anything; every value already has a working default, and `.env` is gitignored.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `POSTGRES_USER` | `bhoomitrace` | Database role |
| `POSTGRES_PASSWORD` | `bhoomitrace` | **Local only** — never reuse as a deployment secret |
| `POSTGRES_DB` | `bhoomitrace` | Application database |
| `POSTGRES_TEST_DB` | `bhoomitrace_test` | Database used by the integration tests |
| `POSTGRES_HOST_PORT` | `5433` | Loopback-only host port (5432 is avoided to dodge a local PostgreSQL) |
| `API_HOST_PORT` | `3000` | Loopback-only host port for the API |
| `FRONTEND_HOST_PORT` | `5173` | Loopback-only host port for the containerised frontend |
| `DATABASE_POOL_MAX` | `10` | API connection pool size |
| `WORKER_DATABASE_POOL_MAX` | `5` | Worker pool size (reserves connections for the API) |
| `LOG_LEVEL` | `info` | `fatal \| error \| warn \| info \| debug \| trace` |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Exact browser origins allowed to call the API. Add yours if you change the frontend port |
| `EXTRACTION_PROVIDER` | `mock` | `mock \| gemini \| groq \| auto`. `mock` is offline and needs no key |
| `WORKER_LEASE_SECONDS` | `60` | Lease staleness bound before a job is recovered (renewed while running) |
| `WORKER_MAX_ATTEMPTS` | `3` | Attempts before a job is marked permanently failed |
| `WORKER_RETRY_BACKOFF_SECONDS` | `5` | Delay before the first retry (doubles each attempt) |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Idle poll interval while the queue is empty |

**Other environment templates:**

- [`backend/.env.example`](backend/.env.example) — the full application surface when
  running the API or worker on the host with `mise`: `HOST`, `PORT`, `DATABASE_URL`,
  `TEST_DATABASE_URL`, `AUTH_SESSION_TTL_HOURS`, `AUTH_RATE_LIMIT_MAX`,
  `COOKIE_SECURE`, `TRUST_PROXY`, `UPLOAD_DIR`, `UPLOAD_MAX_BYTES`,
  `EXTRACTION_TIMEOUT_MS`, provider keys, and worker tuning.
- [`deploy/env/stack.env.example`](deploy/env/stack.env.example) — production
  stack knobs (domain, ports, EBS paths, image refs, S3 backup settings). Contains
  **no secrets**.
- [`deploy/env/secrets.env.example`](deploy/env/secrets.env.example) — documents the
  shape of `deploy/env/secrets.env`, which is generated on the host from AWS SSM
  Parameter Store or Secrets Manager and is never committed.

Production behaviour is not weakened for local convenience: with
`NODE_ENV=production` the application still refuses to start unless
`COOKIE_SECURE=true` and at least one exact `CORS_ALLOWED_ORIGINS` entry is set.

---

## Testing

Everything CI runs can be run locally. Nothing below needs AWS.

**Backend** (from `backend/`, with [mise](https://mise.jdx.dev) providing the pinned
Node 24 — tests are not run inside the container):

```bash
mise exec -- npm run typecheck          # tsc --noEmit
mise exec -- npm test                   # unit + integration
mise exec -- npm run test:unit          # unit only, no database needed
mise exec -- npm run test:integration   # needs the Compose database
```

Integration tests use `TEST_DATABASE_URL`
(`postgres://bhoomitrace:bhoomitrace@127.0.0.1:5433/bhoomitrace_test`), so start
the Compose database first — the test database is created by
`docker/postgres/init/01-create-test-database.sql` on first startup.

**Frontend** (from `frontend/`, using pnpm):

```bash
pnpm install --frozen-lockfile
pnpm test                     # unit and contract tests
pnpm exec tsc --noEmit        # typecheck
pnpm run build                # production bundle
pnpm exec playwright install chromium   # once per machine
pnpm test:e2e                 # browser tests; needs the backend running
```

The Playwright specs drive the real SPA against a running API — they are excluded
from the default `pnpm test` glob so the standard checks stay browser-free.

**Deployment configuration** (from the repository root):

```bash
bash deploy/tests/run.sh
```

This validates the production Compose file and scripts without starting a
container, binding a port, or touching a volume.

**CI scripts** (from the repository root):

```bash
bash .github/scripts/test-ghcr-retention.sh
bash .github/scripts/test-publish-workflow.sh
```

---

## CI/CD and container images

All workflows live in [`.github/workflows/`](.github/workflows).

| Workflow | Trigger | What it does |
| -------- | ------- | ------------ |
| [`ci.yml`](.github/workflows/ci.yml) | Push to `main`/`backend`/`frontend`/`infra/**`/`fix/**`, and every PR, for the backend, frontend, `docker/`, `deploy/`, or workflow paths | Backend typecheck + build, the backend test suite against a real PostgreSQL, frontend unit/contract tests + typecheck + build, the deploy configuration suite, the mocked GHCR retention tests, and a job that validates Compose, builds both images, checks image hygiene, and smoke-tests the running stack. |
| [`publish-image.yml`](.github/workflows/publish-image.yml) | Pushes to `main`, `v*.*.*` tags, manual dispatch | Publishes both images to GHCR with immutable full-SHA tags plus branch and semver tags. |
| [`ghcr-retention-report.yml`](.github/workflows/ghcr-retention-report.yml) | Manual | Reports each package's keep / protected / delete decisions. It is **report-only and read-only** and never deletes. |

**Container images** (published to GitHub Container Registry):

- Backend — [bhoomitrace-backend](https://github.com/users/mosabbir-maruf/packages/container/bhoomitrace-backend) (`ghcr.io/<owner>/bhoomitrace-backend`)
- Frontend — [bhoomitrace-frontend](https://github.com/users/mosabbir-maruf/packages/container/bhoomitrace-frontend) (`ghcr.io/<owner>/bhoomitrace-frontend`)

The local Compose file builds `bhoomitrace-backend:local` and
`bhoomitrace-frontend:local` from source, so the quickstart never depends on these
packages being pullable.

> Destructive retention is intentionally **disabled**. A retained image tag points
> at an index whose platform and attestation manifests are separate, untagged
> package versions; deleting one breaks `docker pull` for every tag that references
> it. Until a manifest-aware policy exists, the job only reports.

---

## Production readiness

`deploy/` contains a **single-host production baseline**: a separate Compose
project, an HTTPS edge proxy, EBS-backed persistence, off-host backups with a
restore drill, monitoring configuration, and a deploy/rollback path built on
immutable images.

It is a baseline, not a production guarantee:

- The AWS-specific steps (SSM Parameter Store or Secrets Manager, S3,
  CloudWatch, and a real Let's Encrypt certificate) have **not** been run against
  real AWS resources.
- A single EC2 instance is not highly available, and an EBS volume is not a
  backup.
- A pre-deployment audit remains **NO-GO for real production**.

Read [verification status](deploy/README.md#15-verification-status) and
[known blockers](deploy/README.md#16-known-blockers-and-limitations-prioritised)
in `deploy/README.md` before treating anything here as deployable. The
[known limitations](#known-limitations) below are the product-side view of the
same picture.

## Documentation map

| Document | Covers |
| -------- | ------ |
| [`backend/README.md`](backend/README.md) | Backend setup and pinned runtime, database schema, migrations, seeding, account bootstrap, API routes and contracts, auth, uploads, audit, the worker and extraction providers, and backend limitations. |
| [`frontend/README.md`](frontend/README.md) | React/Vite setup, styling and structure, the API client and proxy, session and CSRF behaviour from the UI side, tests, typechecking, build, and the frontend container. |
| [`deploy/README.md`](deploy/README.md) | The single-host production baseline: EBS layout, IAM, secrets, TLS, first deploy, backups and restore drills, immutable deploy/rollback, and its own verification status. |
| [`deploy/cloudwatch/alarms.md`](deploy/cloudwatch/alarms.md) | Monitoring: log shipping, alarm configuration commands, and the steps that prove an alert reaches a human. |
| [`LICENSE`](LICENSE) | MIT. |

---

## Known limitations

Honest, current, and mostly tracked as work rather than as bugs:

- **Synthetic data only.** Nothing here has been validated against real land
  records or a real government dataset.
- **No OCR.** Scanned documents are stored; their contents are not transcribed by
  an OCR engine.
- **The extraction review desk is a prototype** and refuses to record a decision
  against the live backend.
- **Documents are not linked to applications** — `applicationId` is not exposed by
  the documents API, so no screen claims a file belongs to a filing.
- **No account lockout**, only per-address rate limiting on authentication.
- **Single-host deployment** is not highly available, and EBS is not a backup. See
  [`deploy/README.md`](deploy/README.md).
- **The AWS path is unverified.** SSM/Secrets Manager, S3, CloudWatch, and a real
  Let's Encrypt certificate have not been exercised against real AWS resources in
  this repository's verification runs.
- **A pre-deployment audit remains NO-GO for real production.**

The detailed, component-owned versions of these live in
[`backend/README.md`](backend/README.md#known-limitations) and
[`frontend/README.md`](frontend/README.md).

---

## License

Released under the [MIT License](LICENSE).

BhoomiTrace is a demonstration project built for **LandTech 2026**. It does not
determine legal ownership and does not issue legal approval.
