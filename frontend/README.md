<div align="center">

<img src="public/favicon.svg" alt="BhoomiTrace" width="100" height="100" />

# BhoomiTrace

### AI-assisted land-record verification and parcel-lineage platform

BhoomiTrace links land-record evidence to traceable values, checks parcel lineage and area/share arithmetic, and surfaces explainable discrepancies for human review.

**Track:** LandTech 2026 &nbsp;·&nbsp; **Challenge:** AI-assisted land-record verification

### 🌐 [Live Demo — devtree.online](https://devtree.online/)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-devtree.online-2ea44f?style=flat-square)](https://devtree.online/)
[![CI](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mosabbir-maruf/BhoomiTrace/actions/workflows/ci.yml)
[![Backend Docker Image](https://img.shields.io/badge/GHCR-Backend%20image-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/mosabbir-maruf/packages/container/bhoomitrace-backend)
[![Frontend Docker Image](https://img.shields.io/badge/GHCR-Frontend%20image-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/mosabbir-maruf/packages/container/bhoomitrace-frontend)
[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639?style=flat-square)](https://github.com/mosabbir-maruf/BhoomiTrace/blob/main/LICENSE)

[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/docs/latest-v24.x/api/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/)
[![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/docs/latest/)
[![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/docs/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/learn)
[![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/guide/)
[![Tailwind CSS 4](https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/docs)
[![Vitest 5](https://img.shields.io/badge/Vitest-5-6DA544?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/guide/)

</div>

> **Demo scope:** The demo uses synthetic records. BhoomiTrace supports verification and review; it does not determine legal ownership or issue official legal approval.

---

> **Guide scope:** Frontend-only setup, UI architecture, API integration, frontend testing, and the frontend container. Start with the [project quickstart](../README.md); backend implementation details live in the [backend guide](../backend/README.md).

## Overview & Key Capabilities

- **Citizen Dashboard & Records Desk**: Inspect land parcels (khatian, dag, mouza, area, and ownership share) with multi-survey historical lineage (CS, SA, RS, BS).
- **Automated Verification & Discrepancies**: Displays automated rule checks (area consistency, CS-to-RS lineage continuity, share sums, document completeness) with reassuring guidance that survey differences represent administrative discrepancies rather than fraud allegations.
- **Application Workflow & Tracking**: Submit and track mutation, record correction, and certified copy applications through realistic lifecycle states with optimistic concurrency version tokens and bilingual Bengali/English input validation.
- **Document Evidence Desk**: Stream-download real stored files (`/api/v1/documents/:id/file`) and inspect document status. The interactive extraction-review desk is a clearly-labelled prototype: it runs only in demo mode and refuses to record a decision against the live backend, because it holds no real extraction identifiers or server version tokens (see *Known backend contract gaps*).
- **Reviewer Queue**: Review open filings and recorded discrepancies, with live interactive decision recording (`under_review`, `resolved`, `dismissed`) with mandatory justification notes persisted to the backend audit trail.

---

## Tech Stack

- **Runtime & UI**: React 19, React DOM 19
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite`)
- **Build Tooling**: Vite 8, TypeScript 5.7
- **Code Quality**: oxfmt, TypeScript strict checks

---

## Getting Started

### Prerequisites

- Node.js 20+
- `pnpm` 9+ (or `npm`)

### Installation

```bash
# From the frontend directory:
pnpm install
```

### Local Development

```bash
pnpm run dev
```

The Vite development server will start on `http://localhost:5173` (matching backend CORS defaults).

### Test, Typecheck & Build

```bash
# Run unit and contract tests
pnpm test

# Run TypeScript compilation check
pnpm exec tsc --noEmit

# Build production bundle
pnpm run build

# Preview the production build locally
pnpm run preview
```

### Browser end-to-end tests

The upload, authentication, CSRF and live/demo-copy paths are covered by
Playwright specs under `tests/`, driving the real SPA against a running backend
(no mocked responses). The dev server is started automatically and proxies `/api`
to `E2E_API_URL`.

```bash
# Backend and database must be running first (e.g. `docker compose up -d`)
pnpm exec playwright install chromium   # once per machine
pnpm test:e2e

# Point at another origin if the defaults do not fit
E2E_BASE_URL=http://127.0.0.1:5173 E2E_API_URL=http://127.0.0.1:3000 pnpm test:e2e
```

The suite registers one synthetic account per run (`tests/e2e/global-setup.ts`),
so it never touches a real identity and stays well inside the auth rate limit.
These specs are outside the `pnpm test` glob and the app `tsconfig.json`, so the
standard CI checks stay browser-free.

> Wiring `pnpm test:e2e` into CI (which needs a browser download and a live
> Compose stack) is an infrastructure change, deliberately left to the CI owner.

---

## Docker

The frontend ships as a container in the root Compose stack: a multi-stage
`frontend/Dockerfile` builds the Vite bundle on Node.js 24 (installing from the
frozen `pnpm-lock.yaml`) and serves only the compiled static output from an
**unprivileged nginx** runtime image (uid 101, port 8080). `vite preview` is
**not** used in production.

```bash
# From the repository root: builds and starts postgres, api, worker and frontend
docker compose up -d --build
# Open the app at http://127.0.0.1:5173
```

Inside the container, nginx serves the SPA with an `index.html` fallback and
reverse-proxies `/api/` to the Compose `api` service while preserving the
complete URI. Because the client's default `API_BASE_URL` is empty, requests go
to relative `/api/v1/...` paths, which nginx forwards to `http://api:3000/api/v1/...`
on the same origin — so session cookies (`bt_session`), the CSRF header
(`x-csrf-token`), document uploads, and streamed downloads all work without CORS.

The proxy accepts request bodies up to 6 MiB (the backend default
`UPLOAD_MAX_BYTES` is 5 MiB); raise `client_max_body_size` in
`frontend/nginx/default.conf` if you increase the backend limit.

To build the image directly (from the repository root):

```bash
docker build -t bhoomitrace-frontend:local ./frontend
```

For a working browser session with the API proxy, use the root [Docker Compose quickstart](../README.md). The standalone image needs a reachable backend service named `api` on its Docker network; the command above intentionally only builds the image.

---

## API client and runtime configuration

The frontend keeps request and session behavior in the client layer under `src/lib/api/`. This section documents how the UI connects to an API; backend routes, schemas, and server-side behavior are documented in the [backend guide](../backend/README.md).

### API base URL

- **Containerised app:** the frontend's default API base is empty, so the browser calls relative `/api/v1/...` endpoints. nginx in `frontend/nginx/default.conf` proxies them to the Compose API on the same origin.
- **Vite development server:** when `VITE_API_URL` is unset, Vite proxies relative API requests to `http://localhost:3000`.
- **Optional override:** set `VITE_API_URL` only if you need to target another API origin.

```env
# Optional; leave unset to use the built-in relative-path proxy.
VITE_API_URL=http://localhost:3000
```

### Session and request handling

- Requests include credentials so the browser can send the HTTP-only session cookie.
- State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) attach the CSRF token in the `x-csrf-token` header.
- Session restoration queries the current-user endpoint without storing passwords or session tokens in `localStorage`.
- Form validation mirrors the backend's 12-character password minimum.
- Upload and streamed-download UI is implemented in the frontend API client; files remain in the backend's private upload storage.

### Explicit demo mode

The UI does not silently replace failed live requests with mock responses. Demo data is selected explicitly via `#/demo/citizen` or `#/demo/reviewer` and is served by `src/mocks/service.ts`, allowing offline exploration of the frontend.

### UI integration boundaries

- The findings/reviewer UI records supported live finding decisions through the API client.
- The extraction-review screen is a labelled prototype. In live mode it refuses to submit a fabricated extraction identifier or version.
- The application detail screen uses the declared document checklist; it does not claim that unrelated uploaded documents are linked to a specific application.

For server routes, request/response schemas, authentication policy, audit records, and known API limitations, use the [backend README](../backend/README.md).
