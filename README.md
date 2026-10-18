<div align="center">

<img src="frontend/public/favicon.svg" alt="BhoomiTrace" width="120" height="120" />

# BhoomiTrace

### AI-assisted land-record verification and parcel-lineage platform

BhoomiTrace extracts values from land records with source links, keeps raw and
reviewed values separate, tracks parcel lineage (split/merge/renumbering),
reconciles areas and shares, and surfaces explainable findings with a full review
and audit trail.

**Track:** LandTech 2026 &nbsp;·&nbsp; **Challenge:** AI-assisted land-record verification

### 🌐 [Live Demo — devtree.online](https://devtree.online/)

⚠️ **Note.** The demo runs on synthetic records only. BhoomiTrace does **not**
determine legal ownership and does **not** issue official legal approval — it
reconciles records, links evidence, and produces findings that a human reviewer
decides on.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-devtree.online-2ea44f?style=flat-square)](https://devtree.online/)
[![CI](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/mosabbir-maruf/BhoomiTrace/pkgs/container/bhoomitrace-backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639?style=flat-square)](LICENSE)

![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white)
![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)
![Tailwind CSS 4](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)

</div>

---

## Repository layout

```
.
├── backend/             Node.js 24 · TypeScript · Fastify · Drizzle · PostgreSQL
│   ├── Dockerfile       Multi-stage image: API, worker, migration CLI
│   └── .dockerignore    Build-context exclusions
├── frontend/            React 19 · TypeScript · Vite · Tailwind CSS frontend
│   ├── Dockerfile       Multi-stage image: Vite build served by unprivileged nginx
│   ├── nginx/           SPA fallback + /api reverse proxy configuration
│   └── .dockerignore    Build-context exclusions
├── docker-compose.yml   Local stack: PostgreSQL, migrations, API, worker, frontend
├── docker/              Container init scripts
└── .github/             CI workflows and the GHCR retention script
```

`frontend/` contains the React 19 web application for citizen tracking, land
record inspection, and reviewer workflows. It ships as a container in the
Compose stack (Vite build served by unprivileged nginx, which reverse-proxies
`/api/` to the backend on the same origin). It can also run on its own with the
Vite dev server against the local API.

## Status

Development proceeds in five phases, each reviewed before the next begins.

| Phase | Description | Status |
| ----- | ----------- | ------ |
| 1 | Backend foundation and database | Complete |
| 2 | Core backend functionality, security, and testing | Complete (Reliability review approved) |
| 3 | Containerization and complete local dev environment | Complete (backend + frontend stack) |
| 4 | GitHub Actions CI/CD and GHCR image publishing | Complete (CI, image publishing, retention) |
| 5 | EC2 deployment, monitoring, backup, and rollback | Not started |

## Running the local stack

The Compose stack is the whole reproducible environment: PostgreSQL, a one-shot
migration job, the API, a separate background worker, and the containerised
frontend. Anything that needs a host Node install (running the API or worker
directly, the test suite, and the optional Vite dev server) is documented in
[`backend/README.md`](backend/README.md) and [`frontend/README.md`](frontend/README.md).

```bash
# from the repository root
cp .env.example .env          # optional: every value already has a safe local default
docker compose up -d --build  # postgres -> migrate (one-shot) -> api + worker + frontend
docker compose ps
curl -sS http://127.0.0.1:3000/health
# open the app: http://127.0.0.1:5173
```

| Service | Published | Notes |
| ------- | --------- | ----- |
| `frontend` | `http://127.0.0.1:5173` | Vite build served by nginx; proxies `/api/` to `api:3000` |
| `api` | `http://127.0.0.1:3000` | `/health` readiness, `/health/live` liveness |
| `postgres` | `127.0.0.1:5433` | containers reach it as `postgres:5432` |
| `worker` | — | separate process, no HTTP surface |
| `migrate` | — | one-shot job; must exit 0 before the API and worker start |

Both published ports are bound to the loopback interface only. The frontend
publishes on `FRONTEND_HOST_PORT` (default `5173`); the API on `API_HOST_PORT`
(default `3000`).

```bash
docker compose logs -f api       # follow the API
docker compose logs -f worker    # follow the worker
docker compose down              # stop, KEEPING both named volumes (data preserved)
```

`docker compose down` preserves the PostgreSQL and upload volumes, so database
rows and uploaded evidence survive a restart. **Never** run
`docker compose down -v` and never prune volumes: that destroys the local
database and every uploaded file.

### Optional: frontend dev server

For hot-reload while working on the UI, run Vite on the host instead of (or
alongside) the containerised frontend. Vite proxies relative `/api/v1` requests
to `http://localhost:3000`, and `CORS_ALLOWED_ORIGINS` already allows
`http://localhost:5173`.

```bash
cd frontend
pnpm install
pnpm run dev        # http://localhost:5173
```

See [`backend/README.md`](backend/README.md) for the complete backend start,
health-check, log, shutdown, and troubleshooting workflow.

## Container images and CI/CD

GitHub Actions (`.github/workflows/`) runs on every push and pull request that
touches the backend, frontend, Docker, or workflow/script paths:

- **`ci.yml`** — backend typecheck/build, the backend test suite against
  PostgreSQL, frontend tests/typecheck/build, the mocked GHCR retention tests,
  and a Compose validation + image-hygiene + end-to-end smoke job.
- **`publish-image.yml`** — publishes both images to GHCR on pushes to `main`,
  version tags (`v*.*.*`), and manual dispatch:
  `ghcr.io/<owner>/bhoomitrace-backend` and
  `ghcr.io/<owner>/bhoomitrace-frontend`. Tags: immutable full-SHA
  (`sha-<40>`), branch, semver (`x.y.z`, `x.y`), and `latest` on the default
  branch only. After publishing, a **report-only audit** job lists each
  package's keep/protected/delete decisions. It never deletes anything:
  destructive retention is disabled until a manifest-aware policy exists,
  because a retained image tag points at an index whose platform and
  attestation manifests are separate, untagged package versions — deleting one
  breaks `docker pull` for every tag that references it.
- **`ghcr-retention-report.yml`** — manual report of the keep/protected/delete
  decisions. It is always report-only and read-only; it never deletes.

## Getting started

See [`backend/README.md`](backend/README.md) for backend development setup, the
containerised stack, database migration, and test commands. See
[`frontend/README.md`](frontend/README.md) for frontend development, Docker
usage, and API integration.
