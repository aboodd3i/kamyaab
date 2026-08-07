# Kamyaab Backend

Trust-based local-services marketplace backend for Karachi, Pakistan.

Connects clients with verified local workers (electricians, plumbers, carpenters, etc.) through an agent-mediated onboarding model.

---

## Project Overview

Kamyaab is a backend API that powers a local-services marketplace. The core workflow is:

1. **Clients** authenticate via phone OTP (Supabase Auth).
2. **Agents** onboard workers by creating worker profiles.
3. **Admins** approve or suspend worker profiles.
4. Workers are matched to clients based on category and area.
5. Clients create job requests (specific worker or open marketplace).
6. Workers accept invitations, bookings are created, and contact info is released.
7. Both parties review each other after booking completion.
8. Complaints can be filed and resolved by admins.
9. All critical actions are recorded in an audit log.

The backend uses Express.js with TypeScript, Prisma ORM, PostgreSQL (via Supabase), and Supabase Auth for identity.

---

## Current Scope (Weeks 1–7)

| Feature | Status |
|---|---|
| Project scaffolding & config | ✅ Week 1 |
| Prisma schema & migrations | ✅ Week 1 |
| Category & area seeding | ✅ Week 1 |
| Supabase JWT validation | ✅ Week 1 |
| Identity mapping (`authUserId`) | ✅ Week 1 |
| Client profile bootstrap (`GET /me`) | ✅ Week 1 |
| Staff login (`POST /auth/login/staff`) | ✅ Week 1 |
| Worker onboarding (`POST /workers`) | ✅ Week 1 |
| Worker approval (`PATCH /workers/:id/verify`) | ✅ Week 1 |
| Role-based authorization | ✅ Week 1 |
| Phone validation (Pakistani) | ✅ Week 1 |
| Centralized error handling | ✅ Week 1 |
| CI pipeline | ✅ Week 1 |
| Public catalog (categories, areas) | ✅ Week 3 |
| Public worker search & discovery | ✅ Week 3 |
| Public worker detail | ✅ Week 3 |
| Worker profile update (agent/admin) | ✅ Week 3 |
| CNIC document upload | ✅ Week 3 |
| Sensitive-data exclusion (public DTO) | ✅ Week 3 |
| PostgreSQL integration tests | ✅ Week 3 |
| Job request lifecycle (draft → submit) | ✅ Week 4 |
| Invitation system (accept/reject) | ✅ Week 4 |
| Booking creation & contact release | ✅ Week 4 |
| Booking completion | ✅ Week 4 |
| Mock SMS notifications | ✅ Week 4 |
| OPEN job matching (deterministic ranking) | ✅ Week 5 |
| Batch invitations (first-accept-wins) | ✅ Week 5 |
| Worker availability (AVAILABLE/BUSY/UNAVAILABLE) | ✅ Week 5 |
| Admin manual assignment | ✅ Week 5 |
| Job expiry cron job | ✅ Week 5 |
| Reviews (client→worker, worker→client) | ✅ Week 6 |
| Complaints (file, resolve, dismiss) | ✅ Week 6 |
| Complaint evidence upload (Supabase Storage) | ✅ Week 6 |
| Audit logging (all critical actions) | ✅ Week 6 |
| End-to-end integration tests | ✅ Week 7 |
| Rate limiting (login + API) | ✅ Week 7 |
| Security audit tests | ✅ Week 7 |
| Dockerfile & docker-compose | ✅ Week 7 |
| Health endpoint (`GET /health`) | ✅ Week 7 |
| Staging deployment guide | ✅ Week 7 |

---

## Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 10
- A **Supabase** project (for Auth + PostgreSQL)
- **Prisma** CLI (installed via `npm install`)
- **Docker** (optional, for containerized deployment)

---

## Installation

```bash
git clone <repo-url>
cd kamyaab-backend
npm ci
```

---

## Environment Configuration

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

### Required Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (pooled, for runtime queries) |
| `DIRECT_URL` | PostgreSQL connection string (direct, for Prisma migrations) |
| `SUPABASE_URL` | Supabase project URL (`https://<project>.supabase.co`) |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (required in production, optional in dev) |
| `SUPABASE_CNIC_BUCKET` | Supabase Storage bucket for CNIC documents |
| `SUPABASE_COMPLAINT_BUCKET` | Supabase Storage bucket for complaint evidence |
| `PORT` | Express listen port (default: `3000`) |
| `NODE_ENV` | `development` / `test` / `staging` / `production` |

### Supabase Setup

1. Create a project at [supabase.com](https://supabase.com).
2. Go to **Settings → API** to find your project URL and keys.
3. Go to **Settings → Database** to find connection strings:
   - Use the **connection pooler** URL for `DATABASE_URL`.
   - Use the **direct connection** URL for `DIRECT_URL`.
4. Enable **Phone Auth** in **Authentication → Providers** (for client OTP).
5. Enable **Email Auth** for staff accounts.
6. Create Storage buckets for CNIC documents and complaint evidence.

### Database URL Configuration

- `DATABASE_URL` — used by the Prisma client at runtime. On Supabase, use the **pooled** connection (port 6543, PgBouncer).
- `DIRECT_URL` — used by Prisma CLI for migrations. Must be the **direct** connection (port 5432) because PgBouncer does not support all migration commands.

---

## Migration Process

```bash
# Set DIRECT_URL for the Prisma CLI
export DIRECT_URL="postgresql://user:password@host:5432/database"

# Create and apply migrations
npm run prisma:migrate

# Or apply existing migrations
npx prisma migrate deploy

# Regenerate the Prisma client after schema changes
npm run prisma:generate
```

---

## Seed Process

Seeds the database with categories, Karachi areas, and staff accounts:

```bash
npm run prisma:seed
```

This is **idempotent** — it uses `upsert` and `createMany` with `skipDuplicates`, so it can be run repeatedly without creating duplicates.

---

## Staff Account Provisioning

Staff accounts (AGENT, ADMIN) must exist in **both** Supabase Auth and the PostgreSQL `User` table, linked by `authUserId`. The provisioning script handles this:

```bash
# Set credentials in .env
ADMIN_EMAIL=admin@kamyaab.pk
ADMIN_PASSWORD=your-secure-password
AGENT1_EMAIL=agent1@kamyaab.pk
AGENT1_PASSWORD=your-secure-password

# Run provisioning
npm run seed:auth
```

This script:
- Creates Supabase Auth users (via service-role key, bypasses email confirmation).
- Upserts Prisma `User` rows with the correct `authUserId` link.
- Is idempotent — skips existing users.

---

## Starting the API

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

The server starts on `http://localhost:3000` (or the port set in `PORT`).

### Health Checks

```bash
curl http://localhost:3000/ping
# {"message":"pong","status":"ok"}

curl http://localhost:3000/health
# {"status":"ok","database":"connected","timestamp":"..."}
```

---

## Running Tests

```bash
# Run all tests once
npm test

# Watch mode
npm run test:watch

# Type checking
npm run typecheck

# Unit tests only
npm run test:unit

# Integration tests only (requires real PostgreSQL)
RUN_DB_INTEGRATION_TESTS=true npm run test:integration

# All tests including integration
RUN_DB_INTEGRATION_TESTS=true npm run test:all
```

Tests use **Vitest** and **Supertest**. Unit tests mock Supabase and Prisma — no real database is required.

**Integration tests** require a real PostgreSQL database and are gated by `RUN_DB_INTEGRATION_TESTS=true`.

---

## Endpoint Summary

### Public (no auth)

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Welcome message |
| `GET` | `/ping` | Simple health check |
| `GET` | `/health` | Full health check with DB connectivity |
| `GET` | `/api/v1/categories` | List all categories (name asc) |
| `GET` | `/api/v1/areas` | List all areas with hierarchy |
| `GET` | `/api/v1/workers` | Search approved workers (filters, pagination) |
| `GET` | `/api/v1/workers/:id` | Worker detail (approved only, 404 otherwise) |

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/login/staff` | None | Staff email/password login |

### Client

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/me` | Bearer JWT | Get identity, bootstrap client profile |
| `POST` | `/api/v1/job-requests` | CLIENT | Create a job request draft |
| `PATCH` | `/api/v1/job-requests/:id` | CLIENT | Update a draft job request |
| `POST` | `/api/v1/job-requests/:id/submit` | CLIENT | Submit job request (sends invitation) |
| `GET` | `/api/v1/job-requests/mine` | CLIENT | List my job requests |
| `POST` | `/api/v1/bookings/:id/complete` | CLIENT | Mark a booking as completed |
| `POST` | `/api/v1/bookings/:id/reviews` | CLIENT | Review the worker (CLIENT_TO_WORKER) |
| `POST` | `/api/v1/reviews` | CLIENT | Review the worker (body-based) |
| `POST` | `/api/v1/complaints` | Any auth | File a complaint (with optional evidence) |

### Worker

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/invitations/pending` | WORKER | List pending invitations |
| `POST` | `/api/v1/invitations/:id/respond` | WORKER | Accept or reject an invitation |
| `POST` | `/api/v1/bookings/:id/reviews/worker` | WORKER | Review the client (WORKER_TO_CLIENT) |
| `POST` | `/api/v1/reviews/worker` | WORKER | Review the client (body-based) |
| `GET` | `/api/v1/availability` | WORKER | Get current availability status |
| `PUT` | `/api/v1/availability` | WORKER | Set availability status |

### Agent

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/workers` | AGENT | Create a worker profile |
| `PATCH` | `/api/v1/workers/:id` | AGENT/ADMIN | Update worker profile |
| `POST` | `/api/v1/workers/:id/documents` | AGENT/ADMIN | Upload CNIC documents |

### Admin

| Method | Path | Auth | Description |
|---|---|---|---|
| `PATCH` | `/api/v1/workers/:id/verify` | ADMIN | Approve or suspend a worker |
| `POST` | `/api/v1/admin/job-requests/:id/assign` | ADMIN | Manually assign a worker to a job |
| `GET` | `/api/v1/complaints` | ADMIN | List all complaints |
| `POST` | `/api/v1/complaints/:id/resolve` | ADMIN | Resolve or dismiss a complaint |
| `GET` | `/api/v1/audit-logs` | ADMIN | List audit logs (with filters) |
| `GET` | `/api/v1/audit-logs/:id` | ADMIN | Get a single audit log |

### Complaints (any authenticated user)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/complaints/:id` | Any auth | Get a complaint by ID |

### Public Worker Search Query Parameters

| Param | Type | Default | Constraints |
|---|---|---|---|
| `categoryId` | string | — | Optional filter |
| `areaId` | string | — | Optional filter |
| `page` | number | 1 | ≥ 1 |
| `limit` | number | 20 | 1–50 |

Results are ordered by `isPriorityListed DESC, rating DESC, completedJobsCount DESC, id ASC`.

### Public Worker Response Shape

The public worker DTO uses an explicit allowlist — sensitive fields (phone, CNIC, addresses, agent assignments, reference contact details, audit fields) are never included:

```json
{
  "id": "...",
  "name": "...",
  "rating": 4.5,
  "ratingCount": 10,
  "completedJobsCount": 5,
  "isPriorityListed": false,
  "verification": {
    "identityChecked": true,
    "phoneConfirmed": true,
    "referenceChecked": false,
    "backgroundChecked": false,
    "skillAssessed": true
  },
  "categories": [{ "id": "...", "name": "..." }],
  "serviceAreas": [{ "id": "...", "name": "...", "parentId": null }]
}
```

### Error Format

All errors follow a consistent machine-readable format:

```json
{
  "success": false,
  "error": {
    "code": "WORKER_NOT_FOUND",
    "message": "Worker was not found"
  }
}
```

---

## Rate Limiting

| Scope | Limit | Window | Key |
|---|---|---|---|
| Login (`/api/v1/auth/*`) | 10 requests | 15 minutes | IP address |
| All API routes (`/api/v1/*`) | 100 requests | 1 minute | IP address |

Rate-limited responses return HTTP 429 with `RATE_LIMITED` error code and a `Retry-After` header.

---

## User Roles

| Role | Can Do |
|---|---|
| **CLIENT** | Authenticate, create job requests, manage bookings, review, complain |
| **AGENT** | Create and update worker profiles, upload CNIC documents |
| **ADMIN** | Approve/suspend workers, assign jobs, resolve complaints, view audit logs |
| **WORKER** | View/respond to invitations, set availability, review clients |

Roles are always read from PostgreSQL — never from JWT claims or request bodies.

---

## Docker

### Build and run with Docker

```bash
docker build -t kamyaab-backend .
docker run -p 3000:3000 --env-file .env kamyaab-backend
```

### Docker Compose (local development with PostgreSQL)

```bash
docker-compose up -d
```

See `docs/deployment.md` for full staging deployment instructions.

---

## Project Structure

```
src/
├── config/          # Environment validation
├── lib/             # Shared utilities (prisma, supabase, errors, phone, DTOs)
├── middleware/      # Auth, rate limiting
├── routes/          # Express route handlers
├── services/        # Business logic layer
├── types/           # TypeScript type definitions
├── __tests__/       # Unit and integration tests
├── app.ts           # Express app factory
└── server.ts        # Server entry point
prisma/
├── schema.prisma    # Database schema
├── migrations/      # SQL migrations
└── seed.ts          # Database seed
scripts/
└── seed-auth.ts     # Staff provisioning
docs/
├── known-risks.md   # Deferred technical risks
└── deployment.md    # Staging deployment guide
```

---

## Features Deferred to Phase 2

- AI-based worker matching (current matching is deterministic)
- Push notifications
- API key authentication for partner integrations
- Multi-language support (Urdu/English)
- Worker self-registration (currently agent-mediated only)
