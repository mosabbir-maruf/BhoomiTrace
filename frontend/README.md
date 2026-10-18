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

To build the image directly:

```bash
docker build -t bhoomitrace-frontend:local ./frontend
docker run --rm -p 127.0.0.1:5173:8080 --add-host api:127.0.0.1 bhoomitrace-frontend:local
```

---

## Backend Integration & API Architecture

The frontend communicates with the BhoomiTrace Fastify backend through a standardized API client layer (`src/lib/api/`):

### Environment Configuration & Default Proxy

- **Real API Default**: The real backend API is the standard development default.
- **Vite Proxy Forwarding**: When `VITE_API_URL` is unset, the client uses relative `/api/v1` endpoints, which Vite forwards to `http://localhost:3000` via its development proxy.
- **No Implicit Mocking**: An unset API URL does **not** silently substitute mock data or fake successful mutations. Mocks are only used when the user explicitly chooses demo mode.
- **Optional Override**:

```env
# Optional: Set an absolute URL if not using the default relative proxy
VITE_API_URL=http://localhost:3000
```

### Authentication & CSRF Synchronizer Token Model

The application adheres to the backend's strict security architecture:

1. **Session Management**: Authentication uses `credentials: "include"`. Fastify sets the HTTP-only `bt_session` cookie for authentication state and the client-readable `bt_csrf` cookie for CSRF token verification.
2. **CSRF Protection**: For state-changing HTTP requests (`POST`, `PUT`, `PATCH`, `DELETE`), the client automatically attaches the `x-csrf-token` header, obtained from memory or the `bt_csrf` cookie.
3. **Session Rehydration**: On application startup, `restoreSession()` queries `GET /api/v1/auth/me` to rehydrate the active session and role without storing sensitive tokens or passwords in `localStorage`.
4. **Password Policy**: Form validations enforce the backend's `PASSWORD_MIN_LENGTH = 12` character policy.

### Real Backend Endpoints Integrated

| Feature Area | Backend Route & Method | Request / Response Contract | Frontend Handler |
| :--- | :--- | :--- | :--- |
| **Authentication** | `POST /api/v1/auth/login` | Body: `{ email, password }` → Sets cookies, returns `{ user, csrfToken }` | `src/lib/api/auth.ts: login()` |
| **Registration** | `POST /api/v1/auth/register` | Body: `{ email, displayName, password }` → Sets cookies, returns `{ user, csrfToken }` | `src/lib/api/auth.ts: register()` |
| **Current User** | `GET /api/v1/auth/me` | Validates session cookie → Returns `PublicUser` | `src/lib/api/session.ts: restoreSession()` |
| **Logout** | `POST /api/v1/auth/logout` | Clears cookies on server | `src/lib/api/session.ts: signOut()` |
| **Applicant Dashboard** | Composed: `/auth/me`, `/parcels`, `/applications`, `/documents` | Loads real user filings, parcels, and attached documents | `src/lib/api/dashboard.ts: fetchApplicantDashboard()` |
| **Parcels List & Detail** | `GET /api/v1/parcels`, `GET /api/v1/parcels/:id` | Returns `Page<Parcel>` / `Parcel` | `src/lib/api/dashboard.ts: fetchParcels(), fetchParcel()` |
| **Parcel Lineage** | `GET /api/v1/parcels/:id/lineage` | Returns incoming/outgoing links & survey arithmetic | `src/lib/api/dashboard.ts: fetchParcel()` |
| **Reconciliation & Rules** | `GET /api/v1/parcels/:id/reconciliation` | Returns deterministic rule outcomes and readiness status | `src/lib/api/review.ts: fetchParcelReconciliation()` |
| **Findings** | `GET /api/v1/parcels/:id/findings` | Returns array of open discrepancy findings | `src/lib/api/review.ts: fetchParcelFindings()` |
| **Application Submission** | `POST /api/v1/applications` + `POST /:id/transitions` | Creates draft application, then transitions to `submitted`, assigning sequence tracking number | `src/lib/api/applications.ts: submitApplication()` |
| **Application Detail** | `GET /api/v1/applications/:id` | Returns application detail, server `today`, timeline audit trail, and the declared document checklist (`declaredDocuments`) | `src/lib/api/dashboard.ts: fetchApplication()` |
| **Reviewer Queue** | `GET /api/v1/review/queue` | Returns `{ pendingExtractions, openFindings, totals }` | `src/lib/api/review.ts: fetchReviewQueue(), fetchAllFindings()` |
| **Reviewer Cases** | `GET /api/v1/applications?limit=50` | Returns reviewer-visible filings mapped to review cases | `src/lib/api/review.ts: fetchReviewCases()` |
| **Finding Decision** | `POST /api/v1/findings/:id/review` | Body: `{ action, reason, version }` → Appends audit decision | `src/lib/api/review.ts: recordFindingReview()` |
| **Extraction Decision** | `POST /api/v1/extractions/:extractionId/review` | Body: `{ outcome, correctedValue, note, version }`. **Prototype only**: the live call is refused (`extraction_review_not_implemented`) because the prototype has no real UUID or server version | `src/lib/api/review.ts: recordReviewOutcome()` |
| **Document Stream** | `GET /api/v1/documents/:id/file` | Streams raw PDF/image file bytes with Content-Disposition header | `src/lib/api/client.ts: apiDownload()` |
| **Document Upload** | `POST /api/v1/documents/upload?title=...&kind=...&reference=...` | One `multipart/form-data` file part into private backend storage. Auth via `bt_session` cookie + `x-csrf-token`; server sniffs PDF/PNG/JPEG and caps at `UPLOAD_MAX_BYTES` (5 MiB) | `src/lib/api/documents.ts: uploadDocument()` |

### Client-Side Demo Fallback

When operating without a backend server or in explicit demo mode (via `#/demo/citizen` or `#/demo/reviewer`), the client falls back to the local demo mock data provider (`src/mocks/service.ts`), allowing full offline exploration and UI demonstration.

---

## Known backend contract gaps

These are backend-owned changes the frontend cannot make on its own. Until they
land, the frontend shows the honest alternative described beside each one.

### 1. Per-application document linkage (Agent 1)

**Problem.** `GET /api/v1/documents` returns the caller's documents but no
`applicationId` or `parcelId`, so nothing links an uploaded file to the
application it was submitted for. The application detail screen previously
listed the entire document collection as if it belonged to the open
application, which mislabels unrelated files.

**Frontend behaviour today.** `fetchApplication()` no longer attaches any
document rows, and the detail screen renders the real
`declaredDocuments` checklist instead. `DocumentItem.applicationId` is always
`null` in live mode.

**Contract change requested.** Add an optional application association to the
document resource and expose it in both directions:

- `POST /api/v1/documents` and `POST /api/v1/documents/upload` accept an
  optional `applicationId` query parameter (UUID, must reference an application
  the caller can see).
- `documentSchema` includes `applicationId: uuid | null` (and, if a document can
  also attach to a parcel, `parcelId: uuid | null`).
- Optionally, `GET /api/v1/applications/:id/documents` returns the documents
  linked to that application, so the detail screen can list real files.

Once `documentSchema.applicationId` exists, the frontend can populate
`DocumentItem.applicationId`, restore document rows on the detail screen, and
have the upload flow pass the current application id.

### 2. Real extraction review (Agent 1)

**Problem.** The interactive extraction-review desk needs a real extraction UUID
and the server's current `version` for each field, plus a supported `outcome`
vocabulary. The prototype is driven by synthetic fixtures, so none of those are
available.

**Frontend behaviour today.** The desk is reachable only in demo mode and is
labelled as a prototype; `recordReviewOutcome()` refuses in live mode with
`extraction_review_not_implemented` rather than posting a fabricated id.

**Contract change requested.** Expose the pending extraction list with
`extractionId` (UUID) and `version` (number) per field — for example through the
existing `GET /api/v1/review/queue` `pendingExtractions`. The review endpoint
already accepts `outcome` of `verified`, `correction`, or `needs_review`; the
frontend will drop the prototype's `dismissed` option when it is wired for real.

