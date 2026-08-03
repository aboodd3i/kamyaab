import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the Kamyaab backend.
 *
 * Why this file exists:
 *   The Supabase-hosted PostgreSQL database has a connection pool limit
 *   (pool_size: 15).  Each integration test file creates its own
 *   PrismaClient (with a PrismaPg adapter that opens a connection pool)
 *   plus a raw pg.Client for cleanup queries.  When Vitest runs all test
 *   files concurrently across multiple worker processes, the combined
 *   connection demand exceeds the pool limit and tests fail with
 *   EMAXCONNSESSION.
 *
 * Solution:
 *   Split tests into two projects:
 *     1. "unit" — non-integration tests, run with default parallelism.
 *     2. "integration" — files matching *.integration.test.ts, run with
 *        fileParallelism disabled so only one integration file executes
 *        at a time.  This keeps the total connection count well within
 *        the pool limit.
 *
 *   Projects run concurrently by default, but the unit tests all mock
 *   Prisma and never open real database connections, so concurrent
 *   execution of unit + integration is safe.
 *
 * This is a test-only configuration change.  Production database pool
 * behavior is not affected.
 */
export default defineConfig({
  test: {
    projects: [
      // ── Unit tests — default parallelism ──────────────────────────
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      // ── Integration tests — serial (one file at a time) ───────────
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          fileParallelism: false,
          // Single thread/worker — no concurrent process spawning
          pool: 'forks',
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          // Integration tests create many DB records in beforeAll/hooks;
          // give them ample time to avoid flaky timeouts.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
