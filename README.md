# BhoomiTrace

BhoomiTrace is an AI-assisted land-record verification and parcel-lineage
platform. It extracts values from land records with source links, keeps raw and
reviewed values separate, tracks parcel lineage (split/merge/renumbering),
reconciles areas and shares, and surfaces explainable findings with a full
review and audit trail.

> **Scope note.** BhoomiTrace does **not** determine legal ownership and does
> **not** issue official legal approval. It reconciles records, links evidence,
> and produces findings that a human reviewer decides on. Records are treated as
> synthetic demo data only.

## Repository layout

```
.
├── backend/             Node.js 24 · TypeScript · Fastify · Drizzle · PostgreSQL
│   ├── Dockerfile       Multi-stage image: API, worker, migration CLI
│   └── .dockerignore    Build-context exclusions
├── docker-compose.yml   Local stack: PostgreSQL, migrations, API, worker
├── docker/              Container init scripts
└── frontend/            React 19 · TypeScript · Vite · Tailwind CSS frontend
```

`frontend/` contains the React 19 web application for citizen tracking, land
record inspection, and reviewer workflows. Build outputs and local caches are ignored.
It is **not** part of the Compose stack and runs separately against the local API.

## Status

Development proceeds in five phases, each reviewed before the next begins.

| Phase | Description | Status |
| ----- | ----------- | ------ |
| 1 | Backend foundation and database | Complete |
| 2 | Core backend functionality, security, and testing | Complete (Reliability review approved) |
| 3 | Containerization and complete local dev environment | Complete (backend stack) |
| 4 | GitHub Actions CI/CD and GHCR image publishing | Not started |
| 5 | EC2 deployment, monitoring, backup, and rollback | Not started |

## Running the local stack

Phase 3 containerises the **backend**: PostgreSQL, a one-shot migration job, the
API, and a separate background worker. This is the whole reproducible backend
stack; anything that needs a host Node install (running the API or worker
directly, and the test suite) is documented in
[`backend/README.md`](backend/README.md).

```bash
# from the repository root
cp .env.example .env          # optional: every value already has a safe local default
docker compose up -d --build  # postgres -> migrate (one-shot) -> api + worker
docker compose ps
curl -sS http://127.0.0.1:3000/health
```

| Service | Published | Notes |
| ------- | --------- | ----- |
| `api` | `http://127.0.0.1:3000` | `/health` readiness, `/health/live` liveness |
| `postgres` | `127.0.0.1:5433` | containers reach it as `postgres:5432` |
| `worker` | — | separate process, no HTTP surface |
| `migrate` | — | one-shot job; must exit 0 before the API and worker start |

Both published ports are bound to the loopback interface only.

```bash
docker compose logs -f api       # follow the API
docker compose logs -f worker    # follow the worker
docker compose down              # stop, KEEPING both named volumes (data preserved)
```

`docker compose down` preserves the PostgreSQL and upload volumes, so database
rows and uploaded evidence survive a restart. **Never** run
`docker compose down -v` and never prune volumes: that destroys the local
database and every uploaded file.

The frontend is **not** containerised in this phase. Run it separately against
`http://127.0.0.1:3000`; `CORS_ALLOWED_ORIGINS` already allows
`http://localhost:5173`. See [`backend/README.md`](backend/README.md) for the
complete start, health-check, log, shutdown, and troubleshooting workflow.

## Getting started

See [`backend/README.md`](backend/README.md) for backend development setup, the
containerised stack, database migration, and test commands. See
[`frontend/README.md`](frontend/README.md) for frontend development and API integration.
