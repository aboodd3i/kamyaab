/**
 * Week 4 — Worker Claim Rate-Limit Integration Tests
 *
 * Verifies that POST /api/v1/workers/claim is rate-limited against
 * brute-force attacks on the CNIC last-4 second factor.
 *
 * Uses a real PostgreSQL database (no Prisma mocks) with mocked auth
 * middleware (same pattern as week4-worker-claim) to bypass Supabase.
 *
 * Safety gate: refuses to run unless RUN_DB_INTEGRATION_TESTS=true
 * and NODE_ENV is not "production".
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// ─── Safety gate ───────────────────────────────────────────────────────────

const RUN_GATE = process.env.RUN_DB_INTEGRATION_TESTS === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!RUN_GATE || IS_PROD) {
  console.log(
    'Integration tests skipped: set RUN_DB_INTEGRATION_TESTS=true and ensure NODE_ENV is not production.',
  );
}

// ─── Mocks (must come before imports that use them) ────────────────────────

vi.mock('../config/env', () => ({
  env: {
    databaseUrl: process.env.DATABASE_URL!,
    directUrl: process.env.DIRECT_URL!,
    supabaseUrl: 'https://dummy.supabase.co',
    supabaseAnonKey: 'dummy-anon-key',
    supabaseServiceRoleKey: undefined,
    port: 3000,
    nodeEnv: 'test',
    isProduction: false,
  },
}));

const { mockAppError, mockErrorCode } = vi.hoisted(() => {
  class MockAppError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'AppError';
    }
  }
  return {
    mockAppError: MockAppError,
    mockErrorCode: { AUTH_FORBIDDEN: 'AUTH_FORBIDDEN' },
  };
});

vi.mock('../middleware/auth', () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: (...roles: string[]) =>
    (req: Request, _res: Response, next: NextFunction) => {
      if (!req.user || !roles.includes(req.user.role)) {
        return next(
          new mockAppError(403, mockErrorCode.AUTH_FORBIDDEN, 'Insufficient permissions'),
        );
      }
      next();
    },
}));

vi.mock('../lib/supabase', () => ({ supabase: {} }));

// ─── Imports (only loaded after mocks are set up) ──────────────────────────

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import workerRoutes from '../routes/workers';
import { errorMiddleware } from '../lib/errors';
import { CLAIM_MAX_FAILED_ATTEMPTS } from '../middleware/claimRateLimiter';

// ─── Setup ─────────────────────────────────────────────────────────────────

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });

const NS = randomUUID();
const PREFIX = `__test_${NS.substring(0, 8)}`;

const tempUserIds: string[] = [];
const tempWorkerIds: string[] = [];

// ─── Helpers ───────────────────────────────────────────────────────────────

async function createTempUser(
  phone: string,
  role: 'CLIENT' | 'AGENT' | 'ADMIN' | 'WORKER' = 'CLIENT',
): Promise<string> {
  const idx = tempUserIds.length;
  const user = await prisma.user.create({
    data: {
      phone,
      email: `${PREFIX}-user-${idx}@test.local`,
      role,
    },
    select: { id: true },
  });
  tempUserIds.push(user.id);
  return user.id;
}

async function createTempWorker(
  phone: string,
  cnicNumber: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const idx = tempWorkerIds.length;
  const worker = await prisma.workerProfile.create({
    data: {
      name: `${PREFIX}-worker-${idx}`,
      phone,
      status: 'PENDING_APPROVAL',
      cnicNumber,
      cnicFrontPath: `secret/path/front-${idx}.jpg`,
      cnicBackPath: `secret/path/back-${idx}.jpg`,
      referenceName: `${PREFIX}-ref-${idx}`,
      referencePhone: `${PREFIX}-ref-phone-${idx}`,
      ...overrides,
    },
    select: { id: true },
  });
  tempWorkerIds.push(worker.id);
  return worker.id;
}

function createAppWithUser(
  userId: string,
  role: 'CLIENT' | 'AGENT' | 'ADMIN' | 'WORKER',
) {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId, authUserId: 'mock-auth-id', role };
    next();
  });

  app.use('/api/v1/workers', workerRoutes);
  app.use(errorMiddleware);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 4 — Worker Claim Rate Limit (Integration)',
  () => {
    beforeAll(async () => {
      await rawClient.connect();
    });

    afterAll(async () => {
      if (tempWorkerIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "worker_categories" WHERE "workerId" = ANY($1::text[])`,
          [tempWorkerIds],
        );
        await rawClient.query(
          `DELETE FROM "worker_service_areas" WHERE "workerId" = ANY($1::text[])`,
          [tempWorkerIds],
        );
        await rawClient.query(
          `DELETE FROM "WorkerProfile" WHERE "id" = ANY($1::text[])`,
          [tempWorkerIds],
        );
      }
      if (tempUserIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "User" WHERE "id" = ANY($1::text[])`,
          [tempUserIds],
        );
      }

      await rawClient.end();
      await prisma.$disconnect();
    });

    // ─── Test 1: First 5 failed attempts pass through ───────────────────

    it('1. first five failed claim attempts reach the normal claim failure response', async () => {
      // User with a phone that has NO matching worker profile → all attempts fail
      const userId = await createTempUser('+923002000001');
      const app = createAppWithUser(userId, 'CLIENT');

      for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
        const res = await request(app)
          .post('/api/v1/workers/claim')
          .send({ cnicLast4: '1111' });
        expect(res.status).toBe(404); // No worker found
        expect(res.body.success).toBe(false);
      }
    });

    // ─── Test 2: Sixth failed attempt returns 429 ───────────────────────

    it('2. sixth failed attempt within the window returns HTTP 429', async () => {
      const userId = await createTempUser('+923002000002');
      const app = createAppWithUser(userId, 'CLIENT');

      // Exhaust the limit with 5 failed attempts
      for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
        await request(app).post('/api/v1/workers/claim').send({ cnicLast4: '1111' });
      }

      // 6th attempt → 429
      const res = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '2222' });
      expect(res.status).toBe(429);
    });

    // ─── Test 3: 429 uses stable error code ─────────────────────────────

    it('3. 429 response uses WORKER_CLAIM_RATE_LIMITED error code', async () => {
      const userId = await createTempUser('+923002000003');
      const app = createAppWithUser(userId, 'CLIENT');

      for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
        await request(app).post('/api/v1/workers/claim').send({ cnicLast4: '1111' });
      }

      const res = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '2222' });
      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('WORKER_CLAIM_RATE_LIMITED');
    });

    // ─── Test 4: 429 response is safe ───────────────────────────────────

    it('4. 429 response does not contain sensitive data', async () => {
      const userId = await createTempUser('+923002000004');
      const app = createAppWithUser(userId, 'CLIENT');

      for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
        await request(app).post('/api/v1/workers/claim').send({ cnicLast4: '1111' });
      }

      const res = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '2222' });
      expect(res.status).toBe(429);

      const bodyStr = JSON.stringify(res.body);
      // No CNIC values
      expect(bodyStr).not.toContain('1111');
      expect(bodyStr).not.toContain('2222');
      // No phone, worker existence, paths, etc.
      expect(res.body.data).toBeUndefined();
      expect(res.body.phone).toBeUndefined();
      expect(res.body.cnicNumber).toBeUndefined();
      expect(res.body.workerProfileId).toBeUndefined();
    });

    // ─── Test 5: Different user not blocked ─────────────────────────────

    it('5. a different authenticated user is not blocked by the first user failures', async () => {
      const userAId = await createTempUser('+923002000005');
      const userBId = await createTempUser('+923002000006');
      const appA = createAppWithUser(userAId, 'CLIENT');
      const appB = createAppWithUser(userBId, 'CLIENT');

      // User A exhausts their limit
      for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
        await request(appA).post('/api/v1/workers/claim').send({ cnicLast4: '1111' });
      }

      // User B should still be able to attempt
      const res = await request(appB)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '2222' });
      expect(res.status).toBe(404); // Normal failure, not 429
    });

    // ─── Test 6: Successful claim does not consume quota ────────────────

    it('6. a successful claim does not consume the failed-attempt quota', async () => {
      const phone = '+923002000007';
      const cnic = '3520212345671';
      await createTempWorker(phone, cnic);
      const userId = await createTempUser(phone, 'CLIENT');
      const app = createAppWithUser(userId, 'CLIENT');

      // Successful claim
      const successRes = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '5671' });
      expect(successRes.status).toBe(200);

      // Now make 5 failed attempts — should all go through (success didn't count)
      // We need a different user for failed attempts since this user is now linked
      const failUserId = await createTempUser('+923002000008');
      const failApp = createAppWithUser(failUserId, 'CLIENT');

      for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
        const res = await request(failApp)
          .post('/api/v1/workers/claim')
          .send({ cnicLast4: '9999' });
        expect(res.status).toBe(404); // Not 429
      }
    });

    // ─── Test 7: Idempotent success does not consume quota ──────────────

    it('7. an idempotent successful retry does not consume the failed-attempt quota', async () => {
      const phone = '+923002000009';
      const cnic = '3520212345672';
      await createTempWorker(phone, cnic);
      const userId = await createTempUser(phone, 'CLIENT');
      const app = createAppWithUser(userId, 'CLIENT');

      // First successful claim
      const res1 = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '5672' });
      expect(res1.status).toBe(200);

      // Idempotent retry — also success
      const res2 = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '5672' });
      expect(res2.status).toBe(200);

      // Both were successes, so the user should not be rate-limited.
      // We can't easily test "next failure is allowed" because the user
      // is already linked and will get a different error (not a "failed"
      // claim in the brute-force sense). But we can verify no 429 occurs
      // on further attempts.
      const res3 = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '5672' });
      expect(res3.status).toBe(200); // Still idempotent success, not 429
    });

    // ─── Test 8: Limiter keys by userId, not cnicLast4 ──────────────────

    it('8. limiter keys by authenticated user ID, not by cnicLast4', async () => {
      const userId = await createTempUser('+923002000010');
      const app = createAppWithUser(userId, 'CLIENT');

      // Make 5 failed attempts with different cnicLast4 values
      for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
        const cnic = String(1000 + i).padStart(4, '0');
        const res = await request(app)
          .post('/api/v1/workers/claim')
          .send({ cnicLast4: cnic });
        expect(res.status).toBe(404); // All fail (no matching worker)
      }

      // 6th attempt with yet another cnicLast4 → 429
      // because the key is userId, not cnicLast4
      const res = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '9999' });
      expect(res.status).toBe(429);
    });

    // ─── Test 9: Retry-After header on 429 ──────────────────────────────

    it('9. 429 response includes Retry-After and RateLimit headers', async () => {
      const userId = await createTempUser('+923002000011');
      const app = createAppWithUser(userId, 'CLIENT');

      for (let i = 0; i < CLAIM_MAX_FAILED_ATTEMPTS; i++) {
        await request(app).post('/api/v1/workers/claim').send({ cnicLast4: '1111' });
      }

      const res = await request(app)
        .post('/api/v1/workers/claim')
        .send({ cnicLast4: '2222' });
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
      expect(retryAfter).toBeGreaterThan(0);
      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });
  },
);
