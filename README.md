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

The backend uses Express.js with TypeScript, Prisma ORM, PostgreSQL (via Supabase), and Supabase Auth for identity.

---

## Current MVP Scope (Week 1–2)

| Feature | Status |
|---|---|
| Project scaffolding & config | ✅ Done |
| Prisma schema & migrations | ✅ Done |
| Category & area seeding | ✅ Done |
| Supabase JWT validation | ✅ Done |
| Identity mapping (`authUserId`) | ✅ Done |
| Client profile bootstrap (`GET /me`) | ✅ Done |
| Staff login (`POST /auth/login/staff`) | ✅ Done |
| Worker onboarding (`POST /workers`) | ✅ Done |
| Worker approval (`PATCH /workers/:id/verify`) | ✅ Done |
| Role-based authorization | ✅ Done |
| Phone validation (Pakistani) | ✅ Done |
| Centralized error handling | ✅ Done |
| Automated tests | ✅ Done |
| CI pipeline | ✅ Done |

---

## Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 10
- A **Supabase** project (for Auth + PostgreSQL)
- **Prisma** CLI (installed via `npm install`)

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
| `PORT` | Express listen port (default: `3000`) |
| `NODE_ENV` | `development` / `test` / `production` |

### Supabase Setup

1. Create a project at [supabase.com](https://supabase.com).
2. Go to **Settings → API** to find your project URL and keys.
3. Go to **Settings → Database** to find connection strings:
   - Use the **connection pooler** URL for `DATABASE_URL`.
   - Use the **direct connection** URL for `DIRECT_URL`.
4. Enable **Phone Auth** in **Authentication → Providers** (for client OTP).
5. Enable **Email Auth** for staff accounts.

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

### Health Check

```bash
curl http://localhost:3000/ping
# {"message":"pong","status":"ok"}
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
```

Tests use **Vitest** and **Supertest**. Supabase and Prisma calls are mocked — no real database or Supabase project is required for unit tests.

---

## Endpoint Summary

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/ping` | None | Health check |
| `POST` | `/api/v1/auth/login/staff` | None | Staff email/password login |
| `GET` | `/api/v1/me` | Bearer JWT | Get identity, bootstrap client profile |
| `POST` | `/api/v1/workers` | AGENT | Create a worker profile |
| `PATCH` | `/api/v1/workers/:id/verify` | ADMIN | Approve or suspend a worker |

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

## User Roles

| Role | Can Do |
|---|---|
| **CLIENT** | Authenticate, view own profile |
| **AGENT** | Create worker profiles |
| **ADMIN** | Approve or suspend workers |

Roles are always read from PostgreSQL — never from JWT claims or request bodies.

---

## Known Limitations

- **No rate limiting** — not yet implemented on auth endpoints.
- **No re-activation** — suspended workers cannot be re-approved in Week 2.
- **No worker self-registration** — workers must be onboarded by an agent.
- **No integration tests with real DB** — tests mock Prisma; no end-to-end DB tests yet.
- **Phone race condition** — concurrent duplicate phone creation could hit the DB unique constraint (returns 500 instead of 409).

---

## Features Deferred to Week 3 / Phase 2

- CNIC (national ID) document uploads
- Reference checks for workers
- Public worker search and discovery
- Ratings and reviews
- Worker availability/scheduling
- Service request/booking flow
- Notifications (SMS/push)
- Rate limiting
- API key authentication for partner integrations
- Multi-language support (Urdu/English)

---

## Project Structure

```
src/
├── config/          # Environment validation
├── lib/             # Shared utilities (prisma, supabase, errors, phone)
├── middleware/      # Auth middleware
├── routes/          # Express route handlers
├── services/        # Business logic layer
├── types/           # TypeScript type definitions
├── app.ts           # Express app factory
└── server.ts        # Server entry point
prisma/
├── schema.prisma    # Database schema
├── migrations/      # SQL migrations
└── seed.ts          # Database seed
scripts/
└── seed-auth.ts     # Staff provisioning
```
