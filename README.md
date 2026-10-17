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
├── docker-compose.yml   Local development services (PostgreSQL)
├── docker/              Container init scripts
└── frontend/            Pre-existing Figma Make scaffold (not tracked here)
```

`frontend/` is a pre-existing Figma Make export that is intentionally **not**
part of version control and is ignored on backend branches. It is handled by the
frontend track, not this one.

## Status

Development proceeds in five phases, each reviewed before the next begins.

| Phase | Description | Status |
| ----- | ----------- | ------ |
| 1 | Backend foundation and database | Complete |
| 2 | Core backend functionality, security, and testing | Not started |
| 3 | Containerization and complete local dev environment | Not started |
| 4 | GitHub Actions CI/CD and GHCR image publishing | Not started |
| 5 | EC2 deployment, monitoring, backup, and rollback | Not started |

## Getting started

See [`backend/README.md`](backend/README.md) for the backend development setup,
database migration, and test commands.
