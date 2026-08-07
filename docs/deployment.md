# Staging Deployment Guide

This guide covers deploying the Kamyaab backend to a staging environment using Render or Railway.

---

## Prerequisites

1. A **Supabase** project (staging) with:
   - PostgreSQL database
   - Phone Auth enabled
   - Email Auth enabled
   - Storage buckets: `cnic-documents` and `complaint-evidence`
2. A **Render** or **Railway** account
3. The Kamyaab backend repository

---

## Environment Variables for Staging

Set the following environment variables in your hosting provider:

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://...@host:6543/postgres` | Pooled connection (PgBouncer) |
| `DIRECT_URL` | `postgresql://...@host:5432/postgres` | Direct connection for migrations |
| `SUPABASE_URL` | `https://<project>.supabase.co` | Supabase project URL |
| `SUPABASE_ANON_KEY` | `eyJ...` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Required in staging (storage uploads) |
| `SUPABASE_CNIC_BUCKET` | `cnic-documents` | Storage bucket name |
| `SUPABASE_COMPLAINT_BUCKET` | `complaint-evidence` | Storage bucket name |
| `PORT` | `3000` | Or let the provider set it |
| `NODE_ENV` | `staging` | Enables service-role key requirement |

---

## Deployment Steps (Render)

### 1. Create a new Web Service

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repository
3. Select the `feat/week7-security-staging` branch (or `main` after merge)
4. Configure:
   - **Runtime**: Node
   - **Build Command**: `npm ci && npx prisma generate && npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`

### 2. Set Environment Variables

Add all variables from the table above in the Render dashboard under **Environment**.

### 3. Deploy

Render will automatically:
1. Install dependencies
2. Generate the Prisma client
3. Build TypeScript
4. Start the server with `node dist/server.js`

### 4. Run Migrations

After the first deploy, run migrations:

```bash
# Using Render shell
npx prisma migrate deploy
```

Or set up a one-off **Background Worker** that runs migrations on deploy:

```bash
npx prisma migrate deploy && node dist/server.js
```

### 5. Seed the Database

```bash
# Using Render shell
npm run prisma:seed
npm run seed:auth
```

---

## Deployment Steps (Railway)

### 1. Create a new project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select the Kamyaab repository

### 2. Configure the service

- **Build Command**: `npm ci && npx prisma generate && npm run build`
- **Start Command**: `npm start`

### 3. Set Environment Variables

Add all variables from the table above in the Railway dashboard under **Variables**.

### 4. Deploy

Railway will automatically build and deploy. Use the Railway CLI or dashboard shell to run migrations and seeds.

---

## Docker Deployment

### Build the image

```bash
docker build -t kamyaab-backend:staging .
```

### Run the container

```bash
docker run -d \
  -p 3000:3000 \
  --env-file .env.staging \
  --name kamyaab-staging \
  kamyaab-backend:staging
```

### Run migrations

```bash
docker exec kamyaab-staging npx prisma migrate deploy
```

---

## Post-Deploy Verification

### 1. Health Check

```bash
curl https://<your-staging-url>/health
# Expected: {"status":"ok","database":"connected","timestamp":"..."}
```

### 2. Ping

```bash
curl https://<your-staging-url>/ping
# Expected: {"message":"pong","status":"ok"}
```

### 3. API Smoke Test

```bash
# List categories (should return seeded data)
curl https://<your-staging-url>/api/v1/categories

# List areas (should return seeded Karachi areas)
curl https://<your-staging-url>/api/v1/areas

# Search workers (should return approved workers or empty list)
curl https://<your-staging-url>/api/v1/workers
```

### 4. Staff Login Test

```bash
curl -X POST https://<your-staging-url>/api/v1/auth/login/staff \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@kamyaab.pk","password":"your-password"}'
```

---

## Acceptance Checklist

- [ ] `/health` returns 200 with `database: connected`
- [ ] `/ping` returns 200 with `pong`
- [ ] `/api/v1/categories` returns seeded categories
- [ ] `/api/v1/areas` returns seeded Karachi areas
- [ ] Staff login (`POST /api/v1/auth/login/staff`) works
- [ ] Rate limiting is active (429 after exceeding limits)
- [ ] Error responses in staging do not leak stack traces
- [ ] Prisma migrations are applied
- [ ] Database seed has been run
- [ ] CI pipeline passes on the deployed branch

---

## Rollback

If the staging deployment fails:

1. **Render**: Go to the service → **Deploy** → select the previous working deploy → **Rollback**
2. **Railway**: Go to the deployment → **Settings** → **Rollback** to previous deployment
3. **Docker**: Stop the new container and restart the previous image version

Database migrations are forward-only. If a migration causes issues, create a new migration to fix the problem rather than rolling back the database.

---

## Monitoring

- **Render**: Built-in logs and metrics in the dashboard
- **Railway**: Built-in logs and metrics in the dashboard
- **Health check**: The `/health` endpoint can be used by external monitors (UptimeRobot, etc.)
- **Docker**: The Dockerfile includes a `HEALTHCHECK` instruction that polls `/health` every 30 seconds
