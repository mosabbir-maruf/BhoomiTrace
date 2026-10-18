<div align="center">

<img src="../frontend/public/favicon.svg" alt="BhoomiTrace" width="100" height="100" />

# BhoomiTrace — Backend

### Node.js 24 · TypeScript (strict) · Fastify · Drizzle ORM · PostgreSQL · Zod · Vitest

**Track:** LandTech 2026 &nbsp;·&nbsp; **Challenge:** AI-assisted land-record verification

### 🌐 [Live Demo — devtree.online](https://devtree.online/)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-devtree.online-2ea44f?style=flat-square)](https://devtree.online/)
[![CI](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/mosabbir-maruf/BhoomiTrace/pkgs/container/bhoomitrace-backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639?style=flat-square)](../LICENSE)

![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white)
![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Vitest 5](https://img.shields.io/badge/Vitest-5-6DA544?style=flat-square&logo=vitest&logoColor=white)

</div>

---

Backend for land-record verification and parcel-lineage work. It records what a
document says, checks a filing against itself and against the documents attached
to it, and keeps an append-only trail of who decided what. It does not determine
legal ownership and does not issue legal approval: everything it raises is a
**discrepancy for a person to resolve**.

This document describes Phase 1 (foundation, schema, database policy),
Phase 2 (authentication, the REST surface, uploaded evidence, deterministic
validation, the reviewer workflow, the audit trail, and the background worker),
and Phase 3 (the containerised local stack: a multi-stage image, Compose
services, migrations as a one-shot job, and the operations workflow).

## Prerequisites

- **Node.js 24 LTS**, installed per-user with [mise](https://mise.jdx.dev). The
  exact version is pinned in `.mise.toml`. Do not install Node globally, via
  Homebrew, or via a global npm install.
- **Docker Desktop**, required for the local database and for the containerised
  backend stack. Docker is *not* required if you run the API and worker directly
  with mise against a containerised database — the workflow in
  [First-time setup](#first-time-setup) below.
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

# 6. Create your first administrator out of band.
#    There is deliberately no route, field, or environment variable that can
#    create a privileged account. Without --password a strong one is generated
#    and printed once.
mise exec -- npm run db:admin -- --email you@example.test --role admin --name "Your Name"
```

If you would rather not change `PATH`, prefix each command with
`~/.local/bin/` instead — for example `~/.local/bin/mise exec -- npm ci`.

Optionally, to make mise permanent for your own shell, run
`echo 'eval "$(mise activate zsh)"' >> ~/.zshrc` yourself. That is a change to
your shell configuration, so it is left to you and is not done by this project.

`docker compose up -d` publishes PostgreSQL on **`127.0.0.1:5433` only** and
creates two databases: `bhoomitrace` (development) and `bhoomitrace_test`
(integration tests). Both come from `docker/postgres/init/`.

## Containerised local stack

The whole backend runs in containers: PostgreSQL, a one-shot migration job, the
API, and a separate background worker. The image is built from
`backend/Dockerfile`; `docker-compose.yml` at the repository root wires the
services together. Nothing in this section needs a host Node install.

**The Compose stack runs the backend and the frontend.** See
[Running the frontend against the local API](#running-the-frontend-against-the-local-api)
for the containerised frontend and the optional host-run Vite dev server.

### Start the stack

```bash
# from the repository root
docker compose up -d --build     # build the image, then start every service
docker compose ps                # postgres + migrate + api + worker
```

Startup order is enforced by Compose, not assumed:

1. `postgres` becomes **healthy** (`pg_isready`).
2. `migrate` runs once and **exits 0** (`node dist/db/migrate-cli.js`).
3. `api` and `worker` start, because they wait on
   `migrate: service_completed_successfully`.

Migrations never run from the API or the worker, so scaling either service
cannot produce two migrators. No `.env` file is required: every value has a safe
local default in `docker-compose.yml`. To override one, copy the root
`.env.example` to `.env`.

### Services, ports, and storage

| Service | Command | Published | Notes |
| ------- | ------- | --------- | ----- |
| `postgres` | `postgres:17-alpine` | `127.0.0.1:5433` | named volume `bhoomitrace-postgres-data` |
| `migrate` | `node dist/db/migrate-cli.js` | — | one-shot, `restart: "no"` |
| `api` | `node dist/server.js` | `127.0.0.1:3000` | health check on `/health` |
| `worker` | `node dist/worker/main.js` | — | no HTTP surface |

Both published ports are bound to the **loopback interface only**, so the stack
is not reachable from another host on the network.

Inside the containers the database URL uses the Compose service name and the
internal port — `postgres://…@postgres:5432/…` — never `localhost`, which inside
a container means the container itself.

Uploaded evidence is written to `/data/uploads` on the named volume
`bhoomitrace-backend-uploads`, shared by the API (which writes) and the worker
(which reads during extraction). The directory is owned by the unprivileged
`node` user (uid 1000), and both processes run as that user.

The local stack sets `NODE_ENV=development` deliberately. Production validation
is not weakened: `NODE_ENV=production` still requires `COOKIE_SECURE=true` and at
least one exact `CORS_ALLOWED_ORIGINS` entry, and the application refuses to
start otherwise.

### Health checks

```bash
# readiness: pings PostgreSQL, returns 503 when the database is unavailable
curl -sS http://127.0.0.1:3000/health

# liveness: never touches the database
curl -sS http://127.0.0.1:3000/health/live

# what the container itself reports
docker compose ps
```

### Logs and status

```bash
docker compose ps                        # service state and health
docker compose logs -f api               # follow the API
docker compose logs -f worker            # follow the worker
docker compose logs --tail=50 migrate    # the migration run
```

Container logs redact the database password; the connection is logged as
`postgres://bhoomitrace:***@postgres:5432/bhoomitrace`.

### Synthetic job smoke test

The worker is a separate process, so a job enqueued through the API proves that
both halves are wired correctly. Log in first (see [Session](#session)
for the cookie and `x-csrf-token` flow), then enqueue. A reconciliation job is
the simplest because it needs no uploaded file:

```bash
curl -sS -b cookies.txt -X POST http://127.0.0.1:3000/api/v1/jobs \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d "{\"kind\":\"parcel_reconciliation\",\"parcelId\":\"$PARCEL_ID\"}"

# poll until it reaches a terminal status
curl -sS -b cookies.txt http://127.0.0.1:3000/api/v1/jobs/$JOB_ID
```

The default provider is `mock`: deterministic, offline, and credential-free. No
live Gemini or Groq request is made locally.

### Migrations and migration failures

`migrate` applies every pending migration once and records it in
`drizzle.__drizzle_migrations`, so re-running is safe. If it fails, the API and
the worker will not start — intentionally, because starting them against an
unmigrated schema would fail later and less clearly. `docker compose ps` shows
`migrate` as `Exited (0)` on success; any other exit code is a failure.

To diagnose one:

```bash
docker compose logs migrate          # the failing statement
docker compose run --rm migrate      # run it again in isolation
```

Migrations are **additive and append-only**: an applied migration file is never
edited, and a correction arrives as a new migration. Do not delete the database
volume to "fix" a migration error; read the log and the
`drizzle.__drizzle_migrations` rows first.

### Stop and restart safely

```bash
docker compose stop api worker   # leave the database running
docker compose start api worker  # start them again
docker compose restart api       # restart one service
docker compose down              # stop everything, KEEPING both named volumes
```

`docker compose down` keeps `bhoomitrace-postgres-data` and
`bhoomitrace-backend-uploads`, so database rows and uploaded evidence survive.
Never run `docker compose down -v`, and never prune volumes: that deletes both
volumes along with the local database and every uploaded file.

A job that is `queued` while the worker is stopped is not lost: it stays in the
database and is claimed when a worker starts again.

### Running the frontend against the local API

The Compose stack includes a containerised frontend (a Vite build served by
unprivileged nginx that reverse-proxies `/api/` to the API on the same origin),
so `docker compose up -d --build` serves the app at `http://127.0.0.1:5173`.
To use the optional host-run Vite dev server instead:

1. Start the backend stack (`docker compose up -d --build`).
2. Confirm `http://127.0.0.1:3000/health` returns `200`.
3. Start the frontend dev server in `frontend/` on port 5173, following its own
   instructions.
4. `CORS_ALLOWED_ORIGINS` already defaults to
   `http://localhost:5173,http://127.0.0.1:5173`. Add your origin if you use a
   different port.

Cookie-based sessions require the browser to send credentials, and every
state-changing request needs an `x-csrf-token` header carrying the token returned
by `POST /api/v1/auth/login`.

## Commands

Run these from `backend/` with `mise` on `PATH`. The `mise exec --` prefix is
what guarantees the pinned Node 24 runtime.

| Command | Purpose |
| ------- | ------- |
| `mise exec -- npm run dev` | Start the API with reload. |
| `mise exec -- npm run worker` | Start the background worker (separate process). |
| `mise exec -- npm run build` | Compile to `dist/` with `tsc`. |
| `mise exec -- npm start` | Run the compiled server. |
| `mise exec -- npm run worker:start` | Run the compiled worker. |
| `mise exec -- npm run typecheck` | Type-check sources and tests without emitting. |
| `mise exec -- npm test` | Run unit **and** integration tests. |
| `mise exec -- npm run test:unit` | Unit tests only (no database required). |
| `mise exec -- npm run test:integration` | Integration tests (requires the Compose database). |
| `mise exec -- npm run db:generate` | Generate a new migration from schema changes. |
| `mise exec -- npm run db:migrate` | Apply pending migrations. |
| `mise exec -- npm run db:seed` | Load the synthetic demo dataset (idempotent). |
| `mise exec -- npm run db:admin -- --email <address> --role <reviewer\|admin>` | Create or update a privileged account from the command line. |

`package.json` sets `engines.node` to `>=24 <25` and `.npmrc` enables
`engine-strict`, so installing or running under a different major fails fast
rather than producing a subtly different result.

There is no lint step yet; correctness is enforced by TypeScript in `strict`
mode (plus `noUncheckedIndexedAccess`) and by the test suite.

## Endpoints

Everything below is served under `/api/v1`. The interactive reference is at
`/docs` and the machine-readable one at `/docs/json`.

### Session

Sessions are database-backed. The session token is a 256-bit random value sent
in an `HttpOnly` cookie (`bt_session`); only its SHA-256 hash is stored, so a
database disclosure cannot be replayed as a live session. A second, readable
cookie (`bt_csrf`) carries a CSRF token whose hash is bound to the session row.

Every state-changing request must either come from an allow-listed `Origin`
(when the header is present) **and** carry the CSRF token in `x-csrf-token`. CORS
is never treated as CSRF protection: a request from a foreign origin is refused
outright, not merely hidden from the browser.

| Route | Purpose |
| ----- | ------- |
| `POST /auth/register` | Register an applicant. Roles cannot be self-assigned. |
| `POST /auth/login` | Start a session. One generic failure for every reason. |
| `POST /auth/logout` | End the session and clear both cookies. |
| `GET /auth/me` | The signed-in account, without any secret material. |

### Parcels, lineage, and evidence

| Route | Purpose |
| ----- | ------- |
| `GET /parcels` | List visible parcels (paginated, filterable). |
| `POST /parcels` | File a parcel. Reviewers cannot file; admins may file for somebody. |
| `GET /parcels/:parcelId` | One parcel. |
| `PATCH /parcels/:parcelId` | Edit a filing (requires the current `version`). |
| `POST /parcels/:parcelId/retire` | Retire a record (owner or admin). Nothing is hard-deleted. |
| `POST /parcels/:parcelId/reinstate` | Bring a retired record back (admin only). |
| `GET /parcels/:parcelId/findings` | Discrepancies raised for this record. |
| `GET /parcels/:parcelId/extractions` | Values read from documents for this record. |
| `POST /parcels/:parcelId/extractions` | Record a value read by hand. |
| `GET /parcels/:parcelId/reconciliation` | The last checks run, without re-running them. |
| `POST /parcels/:parcelId/reconciliation` | Run the deterministic checks now. |
| `GET /parcels/:parcelId/lineage` | Links to earlier and later records. |
| `POST /parcels/:parcelId/lineage` | Add a link. Only a reviewer may mark one `confirmed`. |
| `POST /parcels/:parcelId/lineage/:lineageId/certainty` | Raise or lower certainty (reviewer only). |

### Documents

| Route | Purpose |
| ----- | ------- |
| `GET /documents` | List visible source documents. |
| `POST /documents` | Register a document you already have (no stored file). |
| `POST /documents/upload` | Upload a file (multipart, streamed, size-limited). |
| `GET /documents/:documentId` | One document, without its storage key. |
| `PATCH /documents/:documentId` | Edit metadata (title, reference, status, page count). |
| `GET /documents/:documentId/pages` | The page index. |
| `POST /documents/:documentId/pages` | Add a page to the index. |
| `GET /documents/:documentId/file` | Download the stored file (see limitations). |

### Review, readiness, jobs, and audit

| Route | Purpose |
| ----- | ------- |
| `GET /review/queue` | Work waiting for a reviewer: unclear readings and open findings. |
| `GET /extractions/:extractionId` | One reading. |
| `POST /extractions/:extractionId/review` | Confirm or correct a reading. |
| `GET /extractions/:extractionId/decisions` | Its decision history. |
| `GET /findings/:findingId` | One finding. |
| `POST /findings/:findingId/review` | Record an action on a finding (`under_review`, `resolved`, `dismissed`), with a reason. |
| `GET /findings/:findingId/decisions` | Its decision history. |
| `GET /parcels/:parcelId/readiness` | Past readiness reports for a record. |
| `GET /parcels/:parcelId/readiness/latest` | The most recent one. |
| `POST /parcels/:parcelId/readiness` | Generate one now. |
| `GET /readiness-reports/:reportId` | One report, with its checklist. |
| `GET /jobs` | Background work you can see. |
| `POST /jobs` | Queue work; idempotent per requester on `idempotencyKey`. |
| `GET /jobs/:jobId` | One job, including its result. |
| `POST /jobs/:jobId/cancel` | Cancel work that has not been claimed. |
| `GET /audit-events` | The audit trail (administrators only). |

### Applications

An application is a filing a person makes in this system: a request that is
tracked through a set of states. It is **not** a government decision and nothing
in it confers, transfers, or confirms any right in land — see
[Applications](#applications-1) below for what these states are and the product
decisions still open.

| Route | Purpose |
| ----- | ------- |
| `GET /applications` | List filings: an applicant sees their own, a reviewer or admin sees all. |
| `POST /applications` | File an application as a **draft**. A reviewer may not file; an admin may file for somebody else with `ownerId`. |
| `GET /applications/:applicationId` | One filing, with its `timeline` (read from the audit trail) and the server's `today`. |
| `PATCH /applications/:applicationId` | Edit a draft (requires the current `version`). An applicant may edit only their own draft; a reviewer may not rewrite a filing. |
| `POST /applications/:applicationId/transitions` | Ask for one transition from the workflow. A status is never set directly. |

### Health

| Route | Purpose |
| ----- | ------- |
| `GET /health/live` | Process liveness. Does not touch the database. |
| `GET /health` | Readiness. Probes the database; `503` when it is unreachable. |

## Roles, ownership, and what each role may do

| | Applicant | Reviewer | Admin |
| --- | --- | --- | --- |
| See a parcel | only their own | all | all |
| File / edit a parcel | own only | **no** (record a decision instead) | any, on behalf of an applicant |
| See an application | only their own | all | all |
| File / edit an application | own only, and only while a draft | **no** (record a decision instead) | any |
| Move an application forward | submit their own draft; answer a document request | review steps | any step |
| Record a hand-read value | own parcels | own parcels | any |
| Confirm or correct a reading | no | yes | yes |
| Resolve or dismiss a finding | no | yes | yes |
| Confirm a lineage link | no | yes | yes |
| Retire a parcel | own | no | any |
| Reinstate a parcel | no | no | yes |
| Run reconciliation / readiness | own | any | any |
| Queue and cancel jobs | own records | any | any |
| Read the audit trail | no | no | yes |

Records that a caller may not see answer exactly like records that do not exist:
`404`. That is deliberate, so an identifier cannot be probed for existence.
"Your role may not do this" and "this is not yours" share one message for the
same reason.

Role, user id, and ownership are never read from a request body. A `role` field
in a registration payload is ignored; an applicant's `ownerId` is ignored.

Privileged accounts (`reviewer`, `admin`) exist only if an operator created them
out of band with `npm run db:admin`. There is no route, request field, or
environment variable that can produce a role other than `applicant`, because if
there were, privilege would be one bug away from being self-assigned.

## Authentication, errors, and contract

Failures use one envelope, and the `code` is a stable vocabulary, not a sentence:

```json
{ "error": { "code": "not_found", "message": "…", "requestId": "…" } }
```

| Code | Status | Meaning |
| ---- | ------ | ------- |
| `bad_request` | 400 | The request could not be understood as sent. |
| `validation_failed` | 422 | It was understood but failed its schema. |
| `unauthenticated` | 401 | No usable session. |
| `forbidden` | 403 | Not permitted, or not yours. |
| `not_found` | 404 | No such record, or not visible to you. |
| `conflict` | 409 | The request contradicts current state. |
| `concurrent_modification` | 409 | The record changed since you loaded it. |
| `reference_conflict` | 409 | The change would disconnect data that is still referenced. |
| `idempotency_key_reused` | 409 | The key already stands for a different unit of work; `details.existingJobId` names it. |
| `job_lease_lost` | 409 | The worker no longer holds the job it was working on, so its result was not recorded. |
| `invalid_transition` | 409 | That status change is not available from the state the record is in. |
| `constraint_violation` | 422 | The values are not valid for that record. |
| `payload_too_large` | 413 | Over the size limit. |
| `unsupported_media_type` | 415 | That body type is not accepted. |
| `rate_limited` | 429 | Too many attempts; see `Retry-After`. |
| `internal_error` | 500 | An unexpected fault. Detail is only in the logs. |

A failure body never contains a stack trace, SQL text, a constraint name, a
connection string, a cookie value, or a stored file key. That is asserted by
tests, not merely intended.

**Optimistic concurrency.** Parcels, documents, extractions, and findings carry
a `version` that is advanced by a database trigger. Send the version you read; a
mismatch is `409 concurrent_modification`. Sending an explicit version to the
database overrides the increment, which is available for a deliberate operator
action.

**Request correlation.** Every response carries `x-request-id`, and the same
value appears in the error envelope and in the logs. It is always generated in
this process: a header supplied by the caller is ignored, so it cannot be used
to forge or collide with a log entry.

## Uploaded evidence

- The multipart form accepts **one file part and no fields**; metadata travels in
  the query string. The body is streamed to disk, never buffered whole.
- The size limit (`UPLOAD_MAX_BYTES`, default 5 MiB) is enforced while streaming.
  An over-limit upload removes its partial file **and** leaves no database row.
- The declared content type must match the bytes: PDF (`%PDF-`) and PNG
  (`\x89PNG`) signatures are checked.
- The stored file name is a generated identifier. The original filename is kept
  as metadata only.
- Files live in `UPLOAD_DIR` (default `./.local-storage/uploads`), which is
  private and git-ignored. Uploads, contents, and storage keys never appear in
  Git, logs, or payloads.
- Every stored file gets a SHA-256 checksum, recorded on the document.
- A database failure after the write removes the stored file, so the two cannot
  drift apart.
- Downloads are `private, no-store` and `Content-Disposition: attachment`.

## Validation, findings, and readiness

The checks are deterministic and live in `src/validation/rules.ts`. They read the
record, its hand-written or extracted values, and its lineage, and produce a
result per rule: `pass`, `fail`, `needs_review`, or `not_applicable`.

Areas and shares are compared with exact decimal and rational arithmetic
(`src/lib/rational.ts`), never floating point. `1/3` stays `1/3`, and `0.1 + 0.2`
is never slightly more than `0.3`.

Two distinctions the rules are careful about:

- **A value nobody can read is unknown, not wrong.** An unreadable reading (marked
  unclear, or not parseable as a number at all) produces `needs_review`. Reporting
  it as a mismatch would assert something the data does not support.
- **A finding is a discrepancy to resolve.** It is never a finding of wrongdoing,
  and no rule concludes anything about ownership.

A readiness report is a point-in-time checklist with an outcome:

| Outcome | Meaning |
| ------- | ------- |
| `ready_for_review` | Every check passed or did not apply. This is decision support: it is not an approval, and it makes no statement about ownership. |
| `needs_review` | Nothing high-severity is outstanding, but a person should decide. |
| `not_ready` | A high-severity check failed: unresolved findings, a retired record, and so on. |

Reports are kept, not overwritten. Generating a new one leaves the previous
report and its checklist exactly as they were issued, so you can later see what
was known at the time a decision was made.

## The reviewer workflow

`GET /review/queue` lists what needs a person. A decision is a new row, never an
edit: `review_decisions` is append-only, enforced by a database trigger that
rejects `UPDATE` and `DELETE`, so history can only be added to. Re-running a
review on the same object appends another decision.

- Reviewing a reading records `confirmed` (the value stands) or `corrected`
  (with the value you accepted). `recorded_value` is **never** overwritten: what
  the document said and what a person decided are separate columns.
- Reviewing a finding records the action the reviewer took — `under_review`,
  `resolved`, or `dismissed` — in `review_decisions.finding_action`, alongside an
  outcome that agrees with it (`needs_review`, `verified`, or `dismissed`). The
  action is stored rather than inferred, so a dismissal is never read as a
  confirmation: resolving says the discrepancy is real, dismissing says it is not.
  Resolving or dismissing requires a reason.
- A condition that comes back after being settled raises a **new** finding. The
  settled one keeps its decision.

## Applications

An application is a **tracker entry**: a person says they want something done, and
the system records what they said and which state the request is in. The states
are this system's own vocabulary — `draft`, `submitted`, `under_review`,
`documents_required`, `hearing_scheduled`, `approved`, `rejected` — and an
`approved` application means only that a reviewer in this system moved it to that
state. It is **not** a government approval, and it confers no right in land.

- A filing is created as a **draft**. A reviewer cannot file; an applicant files
  for themselves, and an admin may name an `ownerId` to file on behalf of an
  account. For any other role an `ownerId` in the body is ignored, and the filing
  belongs to the caller.
- A draft belongs to its applicant: only they (or an admin) may edit it, and an
  applicant may edit it only while it is still a draft. A reviewer can read every
  filing but never rewrite one.
- A **tracking number** (`BT-<year>-<5 digits>`) is assigned on submission, drawn
  from a database sequence, and never reissued. It exists only once the filing is
  no longer a draft.
- A status is never set by a client. The caller asks for a transition, and the
  service checks that the transition exists **from the state the row is actually
  in** and that the caller's role may perform it; anything else is
  `invalid_transition`. Every transition carries the `version` the caller read, so
  one step cannot be applied twice.
- A rejection requires a `note`, kept as `decisionNote`. A request for documents
  carries `nextStep` and a `deadline`; both are cleared when the applicant
  responds.
- The `timeline` in `GET /applications/:applicationId` is read from the audit
  trail, so it shows what actually happened, in order, and cannot be edited.
- A `parcelId`, when given, is checked for visibility to the filing's **owner**,
  not to whoever typed it.

**An unresolved product decision.** The state names and the transitions between
them are a plausible demo workflow, not a statutory or official one. Which
authority may move an application between which states, what each state legally
signifies, the official Bengali wording and document checklist for each state, and
whether a withdrawn application should be deleted or retained are all open
questions that this module does not answer on its own. Until they are settled with
a domain owner, **this module is a tracking record only**: it invents no legal
meaning and claims no official workflow. The declared-document codes are likewise
a closed demo list (`deed`, `id`, `khatian`, `tax`, `heir`).

## Background work

Extraction is slow and talks to an outside service, so it never runs inside a
request. `POST /jobs` records the work and returns immediately; the worker
process claims it (`FOR UPDATE SKIP LOCKED`, so several workers can share the
queue without coordinating), does the work outside any transaction, and writes
the result.

- **Leases, not locks.** A claim is a **renewed** lease. A running job extends its
  lease as it works (`renewJobLease`, guarded on the job id **and** the worker id
  **and** the `processing` state **and** a lease that has not already expired, so
  a stale or foreign worker can neither keep a job alive nor resurrect a lease it
  already lost), which means a slow job is not stolen from a healthy worker merely
  because it is slow. If a worker dies mid-job, it stops renewing, the lease
  expires, and `recoverExpiredLeases` returns the job to the queue — or fails it
  once its attempts are exhausted — recording one `job.lease_recovered` event per
  job in the same transaction.
- **Side effects, finalization, and audit are one transaction.** A worker's
  domain writes, its terminal status, the result payload, the lease release, and
  the terminal audit row all commit together (`finalizeClaimedJob`). The
  transaction takes the job row's `FOR UPDATE` lock and re-checks the live lease
  first (`assertJobLeaseHeld`), so a worker whose lease was taken away writes
  **nothing** — the whole thing rolls back and the attempt ends `job_lease_lost`.
  Because the lock is held until commit, a recovery racing the finalization blocks
  and then sees the committed row, which is no longer `processing`; it therefore
  cannot requeue a job whose effects are already committed. This closes the window
  in which effects were committed and a recovery could duplicate them, and it
  means a job never reaches a terminal state without the event that explains it —
  an audit-write failure rolls the transition back with it.
- **Wall clock for lease deadlines, transaction clock for queue eligibility.**
  Lease validity (`leased_until`) is compared against `clock_timestamp()`, because
  a lease is a promise about real time and `now()` (`transaction_timestamp()`) is
  frozen at transaction start and would not move during a long write transaction.
  The single-statement, autocommit claim keeps `now()` for `available_at <= now()`,
  where the two coincide.
- **A bounded number of attempts.** A job that keeps failing is retried with a
  doubling delay up to the job's `max_attempts`, then marked failed with a reason —
  a sanitised one, never a stack trace. Each transition (`job.retry_scheduled`,
  `job.failed`) is written with the status change in one transaction, under the
  job row's lock.
- **Idempotent enqueue, scoped to the requester.** An `idempotencyKey` is a
  client's own label, so it is unique **per requester**, not globally: two
  accounts may use the same key and each gets their own job, and neither is ever
  handed the other's. A repeat that means the same thing returns the existing job
  (`200`) instead of creating a second one (`202`); a repeat that means something
  different is refused with `idempotency_key_reused`. The uniqueness is a partial
  unique index on `(requested_by, idempotency_key)`, not a read-then-insert, so it
  holds under real concurrency.
- **Unreadable output is an outcome, not a failure.** A job whose readings are
  unclear ends `review_required`: a person is needed, and that is a normal result.
- Audit rows written by the worker name the subsystem, not a person. Rows for a
  request the API accepted name the requester.

```bash
mise exec -- npm run worker
```

Run it alongside the API. In production, either configure a real reader or know
that you are running the test double — the worker says so at `error` level if
`NODE_ENV=production` and the provider is `mock`.

### Extraction providers

| `EXTRACTION_PROVIDER` | What it does | What it can read |
| --------------------- | ------------ | ---------------- |
| `mock` (default) | A deterministic test double. Not a reader: it returns only fixtures it was constructed with and marks every other field unclear, with `confidence: null`. | nothing — `readsDocumentContent` is `false` |
| `gemini` | Google Gemini, via `GEMINI_API_KEY`. | PDF, PNG, JPEG |
| `groq` | Groq, via `GROQ_API_KEY`. | PNG, JPEG (it has no document input, so a PDF is refused) |
| `auto` | Gemini first, Groq as fallback. | the union of the members it was built from |

**A reader is handed the document itself.** A provider that reports
`readsDocumentContent: true` is given the stored bytes, with the media type that
was **sniffed** from the file (not the type a client claimed), the byte size, and
the SHA-256 the platform recorded. The worker loads the file from private storage
through a validated path — never from a path supplied in a request, and never as
binary inside a job payload. A record with no stored file, an unsupported media
type, a missing file, or a file whose checksum no longer matches the record is
**refused**: the job fails and stores nothing, rather than answering from the
document's metadata. The mock double declares `readsDocumentContent: false`, and
every job result records whether content was read and whether a stored file was
present, so fixture output can never be mistaken for a reading.

`EXTRACTION_MAX_CONTENT_BYTES` bounds what is sent inline (default 5 MiB, and it
must be at least `UPLOAD_MAX_BYTES` or a file the platform accepted could not be
read back).

`GROQ_MODEL` must be a **vision-capable** model — the default is
`qwen/qwen3.8-27b`. A known text-only value (such as the previous default
`openai/gpt-oss-20b`) is refused at startup with an actionable message, because a
text-only model would answer from the prompt and that answer would be stored as
though it were a reading.

**No live call to an external model has been made from this repository.** The
external adapters are behind an injectable interface and covered by unit tests
with a fake transport that asserts the exact bytes and media type sent, plus
integration tests that drive the real worker against a content-reading provider
and assert on the request it received; their request and response handling has
not been run against the real services, and the default model names in
`.env.example` should be checked before use. Whether a given account's model
accepts a given file is therefore **unverified**. The mock provider is what every
other integration test uses.

## Layout

```
src/
├── app.ts               Fastify construction: plugins, hooks, error handling
├── server.ts            API process bootstrap and graceful shutdown
├── cli/                 Out-of-band account bootstrap
├── config/              Environment loading, constants, logging, redaction
├── db/
│   ├── client.ts        Pooled client, health probe
│   ├── migrate.ts       Migration runner (library)
│   ├── migrate-cli.ts   npm run db:migrate
│   ├── seed.ts          Synthetic seed dataset + fixture repair (library)
│   ├── seed-cli.ts      npm run db:seed
│   └── schema/          Drizzle table definitions, one file per domain area
├── extraction/          Provider interface, mock double, external adapters
├── http/
│   ├── auth-context.ts  Session resolution and per-route authorization
│   ├── cookies.ts       Cookie policy
│   ├── errors.ts        The one error envelope
│   ├── schemas.ts       Every request and response contract (Zod)
│   └── routes/          One module per resource
├── lib/                 Errors, pagination, password hashing, redaction, tokens
├── routes/health.ts     Health endpoints
├── services/            Domain logic, each with its audit events
├── validation/rules.ts  The deterministic checks
└── worker/              Job loop, processors, process entry point
Dockerfile               Multi-stage image build (API, worker, migrate)
.dockerignore            Build-context exclusions for the image
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
- **`origin`** (`synthetic_demo` / `user_created`) is `NOT NULL` with **no
  default**, so every writer must state whether it is creating demonstration data
  or a real filing. There is no value that can be guessed on their behalf.
- **`version`** is advanced by a trigger on every update, including an update made
  by a script or by hand.

### Append-only history, evidence retention, and deletion policy

`review_decisions` and `audit_events` are append-only, enforced by database
triggers that reject `UPDATE` and `DELETE`. Re-running a review inserts a new row;
history is preserved.

Because those triggers reject writes, a referential action that would *rewrite*
or *remove* one of their rows cannot be permitted — the two mechanisms would
contradict each other. The resulting policy:

- Every foreign key held by an append-only table is `ON DELETE RESTRICT`, and
  nothing references an append-only table with `CASCADE` or `SET NULL`. A
  decision's subject and its author cannot be deleted while the decision exists.
- **Evidence retention.** An extraction records where a value came from, so
  `extractions.source_document_id` is `ON DELETE RESTRICT`: a source document
  that an extraction points at cannot be hard-deleted. `SET NULL` would have left
  the extraction standing with its provenance erased — the value would appear to
  have come from nowhere. The column remains nullable, so a **manual-entry
  extraction with no document is fully supported**; only a document that actually
  has evidence attached to it is protected. Unlike the append-only tables, this is
  a normal `RESTRICT` key and not a trigger: a source document referenced by an
  extraction is refused, an unreferenced one is still deletable, and there is no
  mutation check to contradict.
  A supporting index (`extractions_source_document_idx`) keeps that check
  efficient.
- Records that carry history are never hard-deleted. Accounts are deactivated via
  `users.status = 'suspended'`; parcels are **retired** (`lifecycle = 'retired'`,
  with a reason, a time, and an actor) and can be reinstated. There is no delete
  endpoint for a parcel anywhere in the API.
- Owned attributes with no independent meaning (`parcel_dags`) cascade with their
  parent.
- Derived data a reviewer has not yet acted on (`extractions`, `findings`)
  cascades with its parcel. Once review history exists, that cascade is blocked
  by the `RESTRICT` keys, so history always wins and the delete is atomic —
  nothing is partially removed. Deleting such a parcel removes the extraction,
  never the source document it cited.
- Operational rows with no historical meaning cascade: `auth_sessions` with its
  account, `document_pages` with its document, and `readiness_checklist_items`
  with their report.
- `audit_events.entity_type` / `entity_id` are deliberately **not** foreign keys.
  An audit entry records what happened and must outlive the entity it describes.
- `parcel_lineage` uses `ON DELETE RESTRICT` too, so lineage can never be
  silently orphaned.

These behaviours are covered by `test/integration/deletion-policy.test.ts` and
`test/integration/schema-phase2.test.ts`.

### Migrations

The SQL is committed under `drizzle/`; migrations are never edited after being
applied to a shared database. Migrations are **additive**: later ones add tables,
columns, enums, and indexes rather than rewriting the ones before them, and an
`ALTER TYPE ... ADD VALUE` is only ever used where the new value is not *used* in
the same migration. The scoped idempotency-key indexes (`0009`) replace a single
global unique index that could not tell two requesters apart; the migration drops
that index and creates the two narrower ones in its place, which changes no rows.
The `review_decisions.finding_action` column added in the same migration is
nullable on purpose: the append-only guard trigger rejects `UPDATE`, so a legacy
decision cannot be backfilled and instead reports `findingAction: null`. The
applications tables and their tracking-number sequence arrive in `0010` and
`0011`.

`npm run db:seed` is idempotent: it inserts with fixed identifiers, and it also
performs one narrowly scoped repair so that a database seeded before a fixture
wording correction converges in place, without resetting the volume. The repair is
limited to the single fixed synthetic finding id and only matches rows that still
contain the superseded sentence, so it can never overwrite an edited row.

## CI/CD and GHCR

Phase 4 adds GitHub Actions workflows under `.github/workflows/`. They run on
GitHub-hosted `ubuntu-latest` runners and do not depend on a developer's local
Docker state or `.env` files. They trigger on pushes and pull requests that
touch `backend/`, `frontend/`, `docker/`, `docker-compose.yml`,
`.github/workflows/**`, `.github/scripts/**`, `.env.example`, or `README.md`.

### Workflows

- **`ci.yml`** -- backend, frontend, retention, and Docker jobs:
  - `typecheck-build` (backend): `npm ci`, `npm run typecheck`, `npm run build`
    (Node 24).
  - `test` (backend): a `postgres:17-alpine` service container, a test database
    created from the committed init script after checkout, seeded synthetic data,
    then `npm test` against `TEST_DATABASE_URL`.
  - `frontend`: pnpm 9 (compatible with the committed `lockfileVersion 9.0`),
    Node 24, `pnpm install --frozen-lockfile`, `pnpm test`,
    `pnpm exec tsc --noEmit`, and `pnpm run build`.
  - `retention-test`: runs `.github/scripts/test-ghcr-retention.sh`, the mocked
    GHCR retention suite.
  - `docker`: `docker compose config`, `docker compose build` (both images),
    image-hygiene checks for the backend and frontend images, and a Compose smoke
    test (backend readiness and liveness, frontend serving plus SPA fallback, and
    an asserted `/api/` proxy request reaching the backend), then
    `docker compose down`.
- **`publish-image.yml`** -- publishes two images on pushes to `main`, version
  tags (`v*.*.*`), and manual dispatch, using a build matrix:
  `ghcr.io/<owner>/bhoomitrace-backend` and
  `ghcr.io/<owner>/bhoomitrace-frontend`. Tags: immutable full-SHA (`sha-<40>`),
  branch, semver (`x.y.z`, `x.y`), and `latest` only on the default branch. Uses
  `GITHUB_TOKEN` with `packages: write` scoped to the publish and retention jobs
  only; no credentials are passed as build arguments.
- **`ghcr-retention-report.yml`** -- manual (`workflow_dispatch`) report that
  lists package versions and marks keep/delete candidates. It runs in dry-run
  (report) mode unless `delete=true` is explicitly selected.

### GHCR retention policy

Applies to both published packages (`bhoomitrace-backend`,
`bhoomitrace-frontend`). Implemented by `.github/scripts/ghcr-retention.sh`, run
automatically after each publish (delete mode, keep 2) and on demand via
`ghcr-retention-report.yml`.

- **Always kept (never deleted):**
  - the most recent 2 versions by creation time,
  - the most recent 10 versions carrying a `sha-*` tag,
  - every version carrying a semver release tag (`x.y.z` or `x.y`, optional `v`).
- **Deleted automatically after publish:**
  - versions that are neither in the newest 2, nor in the newest 10 SHA-tagged,
    nor semver-tagged -- i.e. older branch-tagged or untagged images.
- **Safety guards (fail closed):** `MODE` must be exactly `report` or `delete`;
  `KEEP_COUNT`/`SHA_KEEP_COUNT` must be positive integers; every version's id,
  creation time, and tag metadata is validated before any decision; a non-array
  or non-200 API page, a malformed response, or an invalid keep set aborts with
  zero deletions; a failed DELETE aborts the remaining deletions and returns
  non-zero; the final count re-checks HTTP status, JSON structure, and every page
  before printing `Retention complete`; file-fixture (`VERSIONS_FILE`) mode
  refuses to run with `MODE=delete` and never issues an HTTP request.
- **Manual override:** `ghcr-retention-report.yml` runs in dry-run (report) mode
  by default; set `delete=true` to delete candidates manually.

### Limitations

- No push to EC2 or any host is performed; deployment belongs to Phase 5.
- Because semver- and SHA-tagged versions are retained, a package may hold more
  than 2 versions when releases exist. Exact "only 2 images" would require
  deleting release references, which is intentionally not done (rollback safety).
- **Package visibility** (public vs. private) is governed by GitHub package
  settings and is not asserted here. After the **first** successful publish,
  open the package under the repository owner's "Packages" and set the intended
  visibility (private by default) in the GitHub UI; this one-time step cannot be
  automated with `GITHUB_TOKEN` alone.

## Known limitations

Recorded honestly, because each of these is a real gap rather than a detail.

- **No OCR.** No Tesseract or other native OCR package is installed. Reading a
  document depends entirely on the configured provider, and the default provider
  is a deterministic double. Local OCR adapters would be optional additions.
- **External readers are unverified.** The Gemini and Groq adapters are unit tested
  against a fake transport that asserts the exact bytes and media type sent, and
  the worker's content path is integration tested against a content-reading
  provider. No **live** request has been made, so whether an account's model
  accepts a given file, and how each vendor reports a malformed response in
  practice, remain unverified.
- **No account lockout.** Brute-force resistance is the rate limit plus Argon2id
  cost, not a lockout counter. A deliberate choice for now, not a guarantee.
- **`areaDecimal` is returned as a string.** The backend always returns exact
  decimals as strings, plus `ownershipShare` as a reduced `"n/d"`. The React
  frontend's contract in `frontend/src/lib/api/` expects `areaDecimal` as a number
  (and camelCase FastAPI-style payloads). This is a **documented mismatch, not a
  frontend change**: the backend work does not alter the frontend contract.
  Anything that consumes a decimal must parse it, not assume a float.
- **The download route is absent from the OpenAPI document's `200` body.** It
  streams a file rather than JSON, so the generated document declares its failure
  responses only. The document is still generated for every other route.
- **The applications module has no settled statutory workflow.** The states and
  transitions are a demo tracker (see [Applications](#applications-1)); which
  authority, wording, and legal meaning each state should have is a product
  decision that remains open, so nothing here should be read as an official
  workflow.
- **Applications differ from the frontend's contract.** The frontend's
  `NewApplicationDraft` field names (`type`, `district`, `upazila`, `mouza`,
  `khatianNumber`, `dagNumber`, `areaDecimal`, `share`, `documents`) match the
  create body, but the frontend's `POST` expects a `{ referenceId, demo: true }`
  acknowledgement while this API returns the application resource and creates it
  as a **draft** (there is no `submit` flag on create); the detail contract's
  `documents: DocumentItem[]` differs from the API's `declaredDocuments: string[]`;
  and the frontend's demo `timeline` copy is Bengali text generated in the client,
  not from the audit trail. The backend work does not alter the frontend contract.
- **Rate limits are per route.** The login and registration budgets are counted
  separately, and both are per client address, not per account.
- **`TRUST_PROXY` is off by default.** Forwarded headers are only honoured when a
  deployment states that a proxy is in front of the process. Turning it on without
  such a proxy lets a caller choose its own address in the logs and in the rate
  limiter.
- **The Compose stack includes the backend and the frontend.**
  `docker-compose.yml` runs PostgreSQL, the one-shot migration job, the API, the
  worker, and a containerised frontend (a Vite build served by unprivileged
  nginx, which reverse-proxies `/api/` to the API on the same origin). The
  optional host-run Vite dev server is documented separately (see
  [Running the frontend against the local API](#running-the-frontend-against-the-local-api)).
- **CI runs, but no production deployment does.** `.github/workflows/` builds
  and tests both packages and publishes both images to GHCR; pushing to a host,
  and any orchestrator-specific configuration, belong to later phases.
- **The base image tracks the Node 24 LTS line, not a digest.**
  `node:24-bookworm-slim` is deliberately not pinned by digest yet; the glibc
  variant is used because `@node-rs/argon2` resolves a prebuilt native binding
  per libc, so an Alpine/musl base is not used.
- **The worker has no health check.** It exposes no HTTP surface, so its health
  is observed through `docker compose ps` (the container stays `Up`) and its
  logs. It verifies database connectivity at startup and exits non-zero when the
  database is unreachable; `restart: unless-stopped` and dependency ordering
  recover it.

## Synthetic data only

All seed data is invented for interface review. No real personal data,
government records, scrape results, OCR output, or model output is present.
BhoomiTrace does not determine legal ownership and does not issue legal
approval; discrepancies are findings for a human reviewer.

## Dependency notes

- **`@types/node` is pinned to the Node 24 line** (`^24.19.2`) to match the
  runtime. It is deduplicated across the whole tree.
- **`@node-rs/argon2`** provides Argon2id. The parameters are pinned to the OWASP
  baseline (`memoryCost 19456`, `timeCost 2`, `parallelism 1`, `outputLen 32`) and
  asserted by a test, so a future dependency bump cannot quietly weaken them.
- **`fastify-type-provider-zod`** makes the Zod schemas the single source of both
  validation and serialisation. The serializer drops any field absent from the
  response schema, which is what keeps `password_hash` and `storage_key` out of
  every payload — including from a future code path that tries to return one.
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
