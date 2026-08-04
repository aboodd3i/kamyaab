/**
 * Unit tests for the worker claim rate limiter.
 *
 * Tests the limiter middleware in isolation using fake timers for
 * window-expiry testing (no real-time sleeps).
 *
 * These tests do NOT touch the database — they use a mock Express
 * pipeline with injected req.user to verify rate-limit behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// Mock env config so errors.ts doesn't validate real env vars
vi.mock('../../config/env', () => ({
  env: {
    databaseUrl: 'postgresql://dummy',
    directUrl: 'postgresql://dummy',
    supabaseUrl: 'https://dummy.supabase.co',
    supabaseAnonKey: 'dummy-anon-key',
    supabaseServiceRoleKey: undefined,
    port: 3000,
    nodeEnv: 'test',
    isProduction: false,
  },
}));

import {
  createClaimRateLimiter,
  resetClaimRateLimitStore,
  CLAIM_WINDOW_MS,
  CLAIM_MAX_FAILED_ATTEMPTS,
} from '../claimRateLimiter';
import { ErrorCode } from '../../lib/errors';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a minimal Express app that:
 *   1. Injects a mock authenticated user (req.user).
 *   2. Applies the claim rate limiter.
 *   3. Simulates a claim handler that always "fails" (returns 400).
 *
 * This lets us test the limiter without touching the DB.
 */
function createAppWithUser(
  userId: string,
  role: 'CLIENT' | 'AGENT' | 'ADMIN' | 'WORKER' = 'CLIENT',
  simulateSuccess = false,
) {
  const app = express();
  app.use(express.json());

  // Inject mock auth principal
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId, authUserId: `auth-${userId}`, role };
    next();
  });

  app.use(createClaimRateLimiter());

  // Simulated claim handler
  app.post('/claim', (_req: Request, res: Response) => {
    if (simulateSuccess) {
      res.status(200).json({
        success: true,
        data: { workerProfileId: 'fake', claimStatus: 'CLAIMED' },
        message: 'Worker profile claimed successfully',
      });
    } else {
      res.status(400).json({
        success: false,
        error: {
          code: ErrorCode.WORKER_CLAIM_FAILED,
          message: 'Unable to verify claim — credentials do not match',
        },
      });
    }
  });

  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Worker Claim Rate Limiter — Unit Tests', () => {
  beforeEach(() => {
    resetClaimRateLimitStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Test 1: First 5 failed attempts pass through ─────────────────────

  it('1. first five failed claim attempts reach the normal claim failure response', async () => {
    const app = createAppWithUser('user-1');

    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      const res = await request(app).post('/claim').send({ cnicLast4: '1111' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ErrorCode.WORKER_CLAIM_FAILED);
    }
  });

  // ─── Test 2: Sixth failed attempt returns 429 ─────────────────────────

  it('2. sixth failed attempt within the window returns HTTP 429', async () => {
    const app = createAppWithUser('user-2');

    // Exhaust the 5 failed attempts
    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      await request(app).post('/claim').send({ cnicLast4: '1111' });
    }

    // Sixth attempt
    const res = await request(app).post('/claim').send({ cnicLast4: '2222' });
    expect(res.status).toBe(429);
  });

  // ─── Test 3: 429 uses stable error code ───────────────────────────────

  it('3. 429 response uses WORKER_CLAIM_RATE_LIMITED error code', async () => {
    const app = createAppWithUser('user-3');

    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      await request(app).post('/claim').send({ cnicLast4: '1111' });
    }

    const res = await request(app).post('/claim').send({ cnicLast4: '2222' });
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ErrorCode.WORKER_CLAIM_RATE_LIMITED);
  });

  // ─── Test 4: 429 response is safe (no sensitive data) ─────────────────

  it('4. 429 response does not contain CNIC, phone, or worker existence info', async () => {
    const app = createAppWithUser('user-4');

    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      await request(app).post('/claim').send({ cnicLast4: '1111' });
    }

    const res = await request(app).post('/claim').send({ cnicLast4: '2222' });
    expect(res.status).toBe(429);

    const bodyStr = JSON.stringify(res.body);
    // Must not contain submitted CNIC values
    expect(bodyStr).not.toContain('1111');
    expect(bodyStr).not.toContain('2222');
    // Must not contain phone or worker existence info
    expect(res.body.data).toBeUndefined();
    expect(res.body.workerProfileId).toBeUndefined();
    expect(res.body.phone).toBeUndefined();
    expect(res.body.cnicNumber).toBeUndefined();
  });

  // ─── Test 5: Different user not blocked ───────────────────────────────

  it('5. a different authenticated user is not blocked by the first user failures', async () => {
    const app1 = createAppWithUser('user-5a');
    const app2 = createAppWithUser('user-5b');

    // User A exhausts their limit
    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      await request(app1).post('/claim').send({ cnicLast4: '1111' });
    }

    // User B should still be able to make attempts
    const res = await request(app2).post('/claim').send({ cnicLast4: '2222' });
    expect(res.status).toBe(400); // Normal failure, not 429
    expect(res.body.error.code).toBe(ErrorCode.WORKER_CLAIM_FAILED);
  });

  // ─── Test 6: Successful claim does not consume quota ──────────────────

  it('6. a successful claim does not consume the failed-attempt quota', async () => {
    // App where the handler always succeeds
    const app = createAppWithUser('user-6', 'CLIENT', true);

    // Make 10 successful claims — should never be rate limited
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/claim').send({ cnicLast4: '1111' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }

    // Now fail once — should still be within the limit
    const failApp = createAppWithUser('user-6');
    const failRes = await request(failApp).post('/claim').send({ cnicLast4: '1111' });
    expect(failRes.status).toBe(400); // Not 429
  });

  // ─── Test 7: Idempotent success does not consume quota ────────────────

  it('7. an idempotent successful retry does not consume the failed-attempt quota', async () => {
    const app = createAppWithUser('user-7', 'CLIENT', true);

    // Multiple successful (idempotent) retries
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/claim').send({ cnicLast4: '1111' });
      expect(res.status).toBe(200);
    }

    // After many successes, a failure should still be allowed
    const failApp = createAppWithUser('user-7');
    const res = await request(failApp).post('/claim').send({ cnicLast4: '9999' });
    expect(res.status).toBe(400); // Not 429
  });

  // ─── Test 8: Limiter keys by userId, not cnicLast4 ────────────────────

  it('8. limiter keys by authenticated user ID, not by cnicLast4', async () => {
    const app = createAppWithUser('user-8');

    // Make 5 failed attempts with different cnicLast4 values each time
    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      const cnic = String(1000 + i).padStart(4, '0');
      const res = await request(app).post('/claim').send({ cnicLast4: cnic });
      expect(res.status).toBe(400);
    }

    // 6th attempt with yet another cnicLast4 — should be 429
    // because the key is userId, not cnicLast4
    const res = await request(app).post('/claim').send({ cnicLast4: '9999' });
    expect(res.status).toBe(429);
  });

  // ─── Test 9: Window expiry resets the counter ─────────────────────────

  it('9. attempts are accepted again after the configured window expires', async () => {
    const app = createAppWithUser('user-9');

    // Exhaust the limit
    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      await request(app).post('/claim').send({ cnicLast4: '1111' });
    }

    // Verify blocked
    const blockedRes = await request(app).post('/claim').send({ cnicLast4: '1111' });
    expect(blockedRes.status).toBe(429);

    // Advance time past the window
    vi.advanceTimersByTime(CLAIM_WINDOW_MS + 1000);

    // Should be allowed again
    const res = await request(app).post('/claim').send({ cnicLast4: '1111' });
    expect(res.status).toBe(400); // Normal failure, not 429
  });

  // ─── Test 10: Retry-After header present on 429 ───────────────────────

  it('10. 429 response includes a Retry-After header', async () => {
    const app = createAppWithUser('user-10');

    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      await request(app).post('/claim').send({ cnicLast4: '1111' });
    }

    const res = await request(app).post('/claim').send({ cnicLast4: '2222' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
    expect(retryAfter).toBeGreaterThan(0);
  });

  // ─── Test 11: RateLimit standard headers present ──────────────────────

  it('11. 429 response includes standard RateLimit headers', async () => {
    const app = createAppWithUser('user-11');

    for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
      await request(app).post('/claim').send({ cnicLast4: '1111' });
    }

    const res = await request(app).post('/claim').send({ cnicLast4: '2222' });
    expect(res.status).toBe(429);
    // express-rate-limit standardHeaders: true adds RateLimit-Policy, RateLimit-Limit, etc.
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });
});
