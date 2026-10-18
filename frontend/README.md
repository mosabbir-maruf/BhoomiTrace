# BhoomiTrace — Frontend

The web interface for **BhoomiTrace**, a land-record verification and mutation application tracking platform for Bangladesh (LandTech 2026 hackathon demo).

Built with **React 19**, **TypeScript 5.7**, **Vite 8**, and **Tailwind CSS v4**.

---

## Overview & Key Capabilities

- **Citizen Dashboard & Records Desk**: Inspect land parcels (khatian, dag, mouza, area, and ownership share) with multi-survey historical lineage (CS, SA, RS, BS).
- **Automated Verification & Discrepancies**: Displays automated rule checks (area consistency, CS-to-RS lineage continuity, share sums, document completeness) with reassuring guidance that survey differences represent administrative discrepancies rather than fraud allegations.
- **Application Workflow & Tracking**: Submit and track mutation, record correction, and certified copy applications through realistic lifecycle states with optimistic concurrency version tokens and bilingual Bengali/English input validation.
- **Document Evidence Desk**: Review source documents, stream-download stored files (`/api/v1/documents/:id/file`), review extractions, and inspect document verification status safely.
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
| **Application Detail** | `GET /api/v1/applications/:id` | Returns application detail, server `today`, and timeline audit trail | `src/lib/api/dashboard.ts: fetchApplication()` |
| **Reviewer Queue** | `GET /api/v1/review/queue` | Returns `{ pendingExtractions, openFindings, totals }` | `src/lib/api/review.ts: fetchReviewQueue(), fetchAllFindings()` |
| **Reviewer Cases** | `GET /api/v1/applications?limit=50` | Returns reviewer-visible filings mapped to review cases | `src/lib/api/review.ts: fetchReviewCases()` |
| **Finding Decision** | `POST /api/v1/findings/:id/review` | Body: `{ action, reason, version }` → Appends audit decision | `src/lib/api/review.ts: recordFindingReview()` |
| **Extraction Decision** | `POST /api/v1/extractions/:id/review` | Body: `{ outcome, correctedValue, note, version }` | `src/lib/api/review.ts: recordReviewOutcome()` |
| **Document Stream** | `GET /api/v1/documents/:id/file` | Streams raw PDF/image file bytes with Content-Disposition header | `src/lib/api/client.ts: apiDownload()` |
| **Document Upload** | `POST /api/v1/documents/upload?title=...&kind=...` | Streams single multipart file part into private backend storage | `src/lib/api/client.ts: apiPost()` |

### Client-Side Demo Fallback

When operating without a backend server or in explicit demo mode (via `#/demo/citizen` or `#/demo/reviewer`), the client falls back to the local demo mock data provider (`src/mocks/service.ts`), allowing full offline exploration and UI demonstration.
