# Known Deferred Technical Risks

This document tracks technical risks that have been intentionally deferred
during the Kamyaab backend implementation. Each item includes its status,
deadline, risk description, and expected future work.

**Summary:** Items 1–3 were resolved during Weeks 3–7. Item 4 remains deferred
pending product decisions.

---

## 1. Authentication and API rate limiting

**Status:** ✅ Resolved (Week 7).

**Resolved in:** `src/middleware/rateLimiter.ts` — per-IP login rate limiter
(10 requests / 15 min) applied to all `/api/v1/auth/*` routes, and per-IP API
rate limiter (100 requests / 1 min) applied to all `/api/v1/*` authenticated
routes. Structured `429 Too Many Requests` responses with `RATE_LIMITED` error
code and `Retry-After` header. Public catalog routes (categories, areas,
public workers) are exempt.

---

## 2. Automated PostgreSQL integration tests

**Status:** ✅ Resolved (Weeks 3–7).

**Resolved in:** Integration tests using real PostgreSQL via `PrismaPg` adapter
with `RUN_DB_INTEGRATION_TESTS=true` gate. Coverage spans Weeks 3–7 including
schema, worker search, job flow, matching, reviews, complaints, audit logs,
and end-to-end marketplace journeys. CI runs integration tests in a PostgreSQL
16 service container.

---

## 3. CI migration testing with ephemeral PostgreSQL

**Status:** ✅ Resolved (Week 7).

**Resolved in:** `.github/workflows/ci.yml` — dedicated `integration` job with
PostgreSQL 16 service container. Runs `prisma migrate deploy` against the
ephemeral database, then executes all integration tests with
`RUN_DB_INTEGRATION_TESTS=true`.

---

## 4. Suspended-worker reactivation

**Status:** Deferred by design for Week 2.

**Risk:** A suspended worker currently cannot necessarily be re-approved.

Do not implement reactivation until the product defines:

- Who may reactivate a worker
- Whether an explanation is mandatory
- Whether verification must be repeated
- Whether complaints or safety flags prevent reactivation
- What audit record must be written
