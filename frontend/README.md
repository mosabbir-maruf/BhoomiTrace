<div align="center">

<img src="public/favicon.svg" alt="BhoomiTrace" width="120" height="120" />

# BhoomiTrace — Frontend

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
[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639?style=flat-square)](../LICENSE)

[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript 5.7](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/)
[![Tailwind CSS 4](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)

</div>

---

This document covers the **frontend only**: setup, structure, the API client and
proxy, session/CSRF behaviour, tests, and the frontend container. Server-side
details — routes and their contracts, database schema, authentication rules,
uploads, audit, and the worker — live in
[`../backend/README.md`](../backend/README.md).

## Overview

The BhoomiTrace SPA is the interface a citizen or a land-office reviewer uses. It
is a React 19 application built by Vite and styled with Tailwind CSS v4, talking to
the Fastify API over relative `/api/v1` paths.

**Key capabilities**

- **Citizen dashboard & records desk** — inspect parcels (khatian, dag, mouza, area,
  ownership share) with multi-survey historical lineage (CS, SA, RS, BS).
- **Automated verification & discrepancies** — rule outcomes for area consistency,
  CS-to-RS lineage continuity, share sums, and document completeness, worded so that
  a survey difference reads as an administrative discrepancy, not an allegation of
  fraud.
- **Application workflow & tracking** — submit and track mutation, record-correction,
  and certified-copy applications through their lifecycle states, with optimistic
  concurrency version tokens and bilingual Bengali/English input validation.
- **Document evidence desk** — stream-download stored files from
  `/api/v1/documents/:id/file` and inspect document status. The interactive
  extraction-review desk is a labelled prototype that runs only in demo mode.
- **Reviewer queue** — review open filings and recorded discrepancies, and record
  decisions (`under_review`, `resolved`, `dismissed`) with a mandatory justification
  note that persists to the backend audit trail.

## Tech stack

| Concern | Choice |
| ------- | ------ |
| Runtime & UI | React 19, React DOM 19 |
| Language | TypeScript 5.7 (strict) |
| Build | Vite 8, `@vitejs/plugin-react` |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite` |
| Formatting | oxfmt |
| Tests | Node's built-in test runner, plus Playwright for browser end-to-end |
| Serving | Unprivileged nginx (`nginxinc/nginx-unprivileged:1.30.6-alpine`) |

## Prerequisites

- **Node.js 24** — the version the CI job and the container build both use.
- **pnpm 9** — the lockfile is `pnpm-lock.yaml`. `npm` will not reproduce it
  faithfully.

## Run it locally

```bash
cd frontend
pnpm install
pnpm run dev
```

The dev server listens on <http://localhost:5173>, which is already in the backend's
default `CORS_ALLOWED_ORIGINS`. It needs a running API to show real data; without
one the app still loads, and the explicit demo routes fall back to local mock data.

Start the database, API, and worker from the repository root — but leave the
containerised frontend out, so the dev server can own port 5173:

```bash
# from the repository root
docker compose up -d postgres api worker

# then, in frontend/
pnpm run dev
```

To run the API and worker on the host with hot reload instead, see
[`../backend/README.md#run-it-locally`](../backend/README.md#run-it-locally).

## Tests, typecheck, and build

```bash
pnpm test                 # unit and contract tests (no browser)
pnpm exec tsc --noEmit    # typecheck
pnpm run build            # production bundle -> dist/
pnpm run preview          # serve the built bundle locally
pnpm run format           # oxfmt
```

### Browser end-to-end tests

The Playwright specs under `tests/e2e/` drive the real SPA against a running
backend — upload, authentication, CSRF, and the live/demo copy paths — with no
mocked responses. The dev server is started automatically and proxies `/api` to
`E2E_API_URL`.

```bash
# the backend must be running first: docker compose up -d --build
pnpm exec playwright install chromium   # once per machine
pnpm test:e2e

# point at another origin if the defaults do not fit
E2E_BASE_URL=http://127.0.0.1:5173 E2E_API_URL=http://127.0.0.1:3000 pnpm test:e2e
```

A single synthetic account is registered per run by `tests/e2e/global-setup.ts`, so
the suite never touches a real identity and stays inside the authentication rate
limit. These specs sit outside the `pnpm test` glob and the app `tsconfig.json`, so
the standard checks stay fast and browser-free.

> Wiring `pnpm test:e2e` into CI needs a browser download and a live Compose stack.
> It is deliberately not part of `.github/workflows/ci.yml`.

## Run everything in Docker

`frontend/Dockerfile` is a multi-stage build: it compiles the Vite bundle on
Node.js 24 from the frozen `pnpm-lock.yaml`, then copies **only the static output**
into an unprivileged nginx runtime image (uid 101, port 8080). `vite preview` is not
used in production, and the runtime image contains no Node.js, no pnpm, and no
source.

`frontend/nginx/default.conf` serves the SPA with an `index.html` fallback, caches
hashed assets under `/assets/` for a year, and reverse-proxies `/api/` to the
Compose `api` service while preserving the full URI. The proxy accepts request
bodies up to 6 MiB, which is headroom over the backend's 5 MiB `UPLOAD_MAX_BYTES`
default; raise `client_max_body_size` if you raise the backend limit.

```bash
# the normal path, from the repository root
docker compose up -d --build      # app at http://127.0.0.1:5173

# or build and run the image directly
docker build -t bhoomitrace-frontend:local ./frontend
docker run --rm -p 127.0.0.1:5173:8080 --add-host api:127.0.0.1 bhoomitrace-frontend:local
```

The direct `docker run` form needs `--add-host api:127.0.0.1` because nginx resolves
the Compose service name `api`; on its own there is nothing to proxy to unless you
point it at a running API.

## API client, proxy, and environment

All HTTP goes through the typed client in `src/lib/api/`.

**`VITE_API_URL` (or `VITE_API_BASE_URL`) — the API base, baked in at build time.**
Leave it unset and the client uses **relative** `/api/v1/...` paths, which is the
supported default both in the dev server and behind the containerised nginx. An
unset value never silently substitutes mock data.

```env
# Optional: only if you are not using the default relative proxy
VITE_API_URL=http://localhost:3000
```

**`VITE_BACKEND_URL` — the dev-server proxy target only.** `vite.config.ts` proxies
`/api` to `http://localhost:3000` by default; `VITE_BACKEND_URL` overrides it. This
variable is read by the Vite server process, not by the browser bundle, and
Playwright sets it to `E2E_API_URL`.

When the app is served by nginx, the proxy is `frontend/nginx/default.conf`
(`proxy_pass http://api:3000`) and `VITE_BACKEND_URL` is irrelevant.

### Session and CSRF, from the UI's point of view

The UI never stores a token or a password in `localStorage`. Authentication is a
server-side session:

1. **Cookies.** Login and registration return two cookies: `bt_session`, which is
   HTTP-only and carries the session, and `bt_csrf`, which is deliberately readable
   by scripts. Requests are sent with `credentials: "include"`.
2. **CSRF header.** On every state-changing request (`POST`, `PUT`, `PATCH`,
   `DELETE`) the client attaches `x-csrf-token`, taken from memory or read back from
   the `bt_csrf` cookie.
3. **Rehydration.** On startup, `restoreSession()` calls `GET /api/v1/auth/me` to
   recover the current user and role before rendering authenticated routes.
4. **Password policy.** The forms enforce the backend's minimum length of 12
   characters.

Because the composed stack serves the SPA and the API on the same origin, cookies
and the CSRF header travel without any CORS involvement. Running the dev server
against the API directly is cross-origin, which is exactly what
`CORS_ALLOWED_ORIGINS` and `credentials: "include"` are for.

### Connections and correlation

`src/lib/api/client.ts` parses every response into a typed result or a normalized
`ApiError` (carrying `status`, a stable `code`, and the request id), keeps an
in-memory CSRF token, and reads the `x-request-id` response header so a user-visible
failure can be quoted to an operator. The correlation id is always generated by the
API; a client cannot set it.

## Integration boundaries

Two backend capabilities the UI would use do not exist yet. Until they do, the UI
shows the honest alternative rather than a fabricated one. Both are backend-owned
changes; the API contracts are described in
[`../backend/README.md`](../backend/README.md#endpoints).

**1. Documents are not linked to an application.** The documents API returns the
caller's documents without an `applicationId`, so nothing associates an uploaded
file with the filing it was submitted for. The application detail screen therefore
renders the real `declaredDocuments` checklist instead of a document list, and
`DocumentItem.applicationId` is always `null` in live mode. Restoring document rows
needs an optional application association on the document resource.

**2. Extraction review has no real identifiers.** The interactive desk needs a real
extraction UUID, the server's current `version` per field, and a supported `outcome`
vocabulary. It is driven by synthetic fixtures, so it is reachable only in demo mode
and is labelled a prototype; in live mode `recordReviewOutcome()` refuses with
`extraction_review_not_implemented` rather than posting a fabricated id.

## Frontend limitations

- **No OCR and no live extraction path.** The UI displays extraction state; it does
  not read documents. The default provider is an offline mock.
- **The extraction-review desk is a prototype**, as described above.
- **Demo mode is explicit.** `#/demo/citizen` and `#/demo/reviewer` fall back to the
  local mock provider (`src/mocks/service.ts`) for offline exploration. That
  fallback is never triggered implicitly.
- **No account lockout UI.** Failed logins are rate limited per address by the API,
  not locked per account.
- **Browser end-to-end tests are not run in CI** (see the note above).

## Structure

```
frontend/
├── Dockerfile              Multi-stage build -> unprivileged nginx runtime
├── nginx/default.conf      SPA fallback, asset caching, /api/ reverse proxy
├── index.html              SPA host document
├── vite.config.ts          Dev server, /api proxy target, build settings
├── playwright.config.ts    Browser end-to-end configuration
├── public/                 Favicon set, Bengali fonts, robots.txt, sitemap.xml
├── src/
│   ├── main.tsx            Browser bootstrap
│   ├── App.tsx             Route table
│   ├── components/         App shell, navigation, shared UI primitives
│   ├── features/           auth, citizen, reviewer, evidence, public screens
│   ├── hooks/              Hash routing, async data loading, per-route SEO
│   ├── lib/api/            Typed API client (auth, documents, review, session)
│   ├── config/             Navigation and route metadata
│   └── mocks/              Offline demo data provider
└── tests/                  Contract tests and Playwright e2e specs
```

## Related documentation

- [`../README.md`](../README.md) — the project runbook and quickstart.
- [`../backend/README.md`](../backend/README.md) — API contracts, database, auth,
  uploads, audit, and the worker.
- [`../deploy/README.md`](../deploy/README.md) — deployment, TLS, backups, and
  monitoring.
