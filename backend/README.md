# BhoomiTrace backend

Node.js 24 · TypeScript (strict) · Fastify · Drizzle ORM · PostgreSQL · Zod · Vitest

Backend for land-record verification and parcel-lineage work. It records what a
document says, checks a filing against itself and against the documents attached
to it, and keeps an append-only trail of who decided what. It does not determine
legal ownership and does not issue legal approval: everything it raises is a
**discrepancy for a person to resolve**.

This document describes Phase 1 (foundation, schema, database policy) and
Phase 2 (authentication, the REST surface, uploaded evidence, deterministic
validation, the reviewer workflow, the audit trail, and the background worker).

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
| `POST /findings/:findingId/review` | Resolve or dismiss a finding, with a reason. |
| `GET /findings/:findingId/decisions` | Its decision history. |
| `GET /parcels/:parcelId/readiness` | Past readiness reports for a record. |
| `GET /parcels/:parcelId/readiness/latest` | The most recent one. |
| `POST /parcels/:parcelId/readiness` | Generate one now. |
| `GET /readiness-reports/:reportId` | One report, with its checklist. |
| `GET /jobs` | Background work you can see. |
| `POST /jobs` | Queue work (idempotent on `idempotencyKey`). |
| `GET /jobs/:jobId` | One job, including its result. |
| `POST /jobs/:jobId/cancel` | Cancel work that has not been claimed. |
| `GET /audit-events` | The audit trail (administrators only). |

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
- Resolving or dismissing a finding requires a reason, and records both outcomes
  as `verified` in the decision history, with the before and after state in the
  audit trail.
- A condition that comes back after being settled raises a **new** finding. The
  settled one keeps its decision.

## Background work

Extraction is slow and talks to an outside service, so it never runs inside a
request. `POST /jobs` records the work and returns immediately; the worker
process claims it (`FOR UPDATE SKIP LOCKED`, so several workers can share the
queue without coordinating), does the work outside any transaction, and writes
the result.

- **Leases, not locks.** A claim is a lease. If a worker dies mid-job, the lease
  expires and the job is recovered and retried rather than stranded.
- **A bounded number of attempts.** A job that keeps failing is retried with a
  doubling delay up to `WORKER_MAX_ATTEMPTS`, then marked failed with a reason —
  a sanitised one, never a stack trace.
- **Idempotent enqueue.** A repeated `idempotencyKey` returns the existing job
  (`200`) instead of creating a second one (`202`).
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

| `EXTRACTION_PROVIDER` | What it does |
| --------------------- | ------------ |
| `mock` (default) | A deterministic test double. Not a reader: it returns only fixtures it was constructed with and marks every other field unclear, with `confidence: null`. |
| `gemini` | Google Gemini, via `GEMINI_API_KEY`. |
| `groq` | Groq, via `GROQ_API_KEY`. |
| `auto` | Gemini first, Groq as fallback. |

**No live call to an external model has been made from this repository.** The
external adapters are behind an injectable interface and covered by unit tests
with a fake transport; their request and response handling has not been run
against the real services, and the default model names in `.env.example` should
be checked before use. The mock provider is what every integration test uses.

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
applied to a shared database. `npm run db:seed` is idempotent: it inserts with
fixed identifiers, and it also performs one narrowly scoped repair so that a
database seeded before a fixture wording correction converges in place, without
resetting the volume. The repair is limited to the single fixed synthetic finding
id and only matches rows that still contain the superseded sentence, so it can
never overwrite an edited row.

## Known limitations

Recorded honestly, because each of these is a real gap rather than a detail.

- **No OCR.** No Tesseract or other native OCR package is installed. Reading a
  document depends entirely on the configured provider, and the default provider
  is a deterministic double. Local OCR adapters would be optional additions.
- **External readers are unverified.** The Gemini and Groq adapters are unit
  tested against a fake transport only. No live request has been made.
- **No account lockout.** Brute-force resistance is the rate limit plus Argon2id
  cost, not a lockout counter. A deliberate choice for now, not a guarantee.
- **`areaDecimal` is returned as a string.** The backend always returns exact
  decimals as strings, plus `ownershipShare` as a reduced `"n/d"`. The Figma Make
  frontend's contract in `frontend/src/lib/api/` expects `areaDecimal` as a number
  (and camelCase FastAPI-style payloads). This is a **documented mismatch, not a
  frontend change**: the frontend is untouched and uncommitted on this branch.
  Anything that consumes a decimal must parse it, not assume a float.
- **The download route is absent from the OpenAPI document's `200` body.** It
  streams a file rather than JSON, so the generated document declares its failure
  responses only. The document is still generated for every other route.
- **No `applications` module.** The frontend's `Application*` types have no
  counterpart here; they are a later phase.
- **Rate limits are per route.** The login and registration budgets are counted
  separately, and both are per client address, not per account.
- **`TRUST_PROXY` is off by default.** Forwarded headers are only honoured when a
  deployment states that a proxy is in front of the process. Turning it on without
  such a proxy lets a caller choose its own address in the logs and in the rate
  limiter.
- **No application Dockerfile, production Compose service, or CI workflow** is
  part of this phase.

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
