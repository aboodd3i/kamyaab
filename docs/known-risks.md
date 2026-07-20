# Known Deferred Technical Risks

This document tracks technical risks that have been intentionally deferred
during the Kamyaab backend Weeks 1 and 2 implementation. Each item includes
its status, deadline, risk description, and expected future work.

---

## 1. Authentication and API rate limiting

**Status:** Deferred.

**Deadline:** Required before publicly accessible staging, external mobile
testing, or pilot usage.

**Risk:** Authentication and other sensitive endpoints may be vulnerable to
brute-force attempts or request abuse without throttling.

**Expected future work:**

- Per-IP limits
- Per-phone or per-identity limits where applicable
- Appropriate handling for trusted internal traffic
- Structured `429 Too Many Requests` responses
- Monitoring of repeated authentication failures

---

## 2. Automated PostgreSQL integration tests

**Status:** Deferred.

**Deadline:** Required before the booking and invitation workflow becomes
complex, preferably before Week 4.

**Risk:** Mocked Prisma tests do not verify actual PostgreSQL constraints,
transactions, SQL migrations, or database-specific behavior.

**Expected future work:**

- Disposable PostgreSQL test database
- Migration execution during tests
- Seed verification
- Real constraint testing
- Transaction and concurrency tests

---

## 3. CI migration testing with ephemeral PostgreSQL

**Status:** Deferred.

**Deadline:** Recommended before Week 4 and required before pilot deployment.

**Risk:** CI currently validates Prisma and compiles the application but does
not prove that migrations apply successfully to an empty PostgreSQL database.

**Expected future work:**

- PostgreSQL service container in GitHub Actions
- `prisma migrate deploy`
- Seed smoke test
- Migration status verification
- Database integration test job

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
