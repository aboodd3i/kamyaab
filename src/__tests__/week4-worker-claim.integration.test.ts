/**
 * Week 4 — Worker Profile Claim Flow Integration Tests
 *
 * Verifies that POST /api/v1/workers/claim securely links an authenticated
 * phone-OTP user to an agent-created WorkerProfile whose userId is null.
 *
 * Uses a real PostgreSQL database (no Prisma mocks) with mocked auth
 * middleware (same pattern as week4-myjobs-contact-release) to bypass
 * Supabase.
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

// Import errors in the hoisted scope so the mocked requireRole can use it
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

// Mock the auth middleware — authenticate is a no-op (test injects req.user),
// requireRole uses the real role-checking logic.
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

// Mock supabase — not used in worker claim route
vi.mock('../lib/supabase', () => ({ supabase: {} }));

// ─── Imports (only loaded after mocks are set up) ──────────────────────────

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import workerRoutes from '../routes/workers';
import { errorMiddleware } from '../lib/errors';

// ─── Setup ─────────────────────────────────────────────────────────────────

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });

/** Unique namespace for all temporary records created by this test run. */
const NS = randomUUID();
const PREFIX = `__test_${NS.substring(0, 8)}`;

// Track all temporary IDs for cleanup
const tempUserIds: string[] = [];
const tempWorkerIds: string[] = [];

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a temp User with a specific phone and role.
 * Returns the user ID.
 */
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

/**
 * Create a temp WorkerProfile with a specific phone, CNIC, and status.
 * userId is null by default (unclaimed).
 */
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

/**
 * Create an Express app with a forced auth principal (bypasses Supabase).
 * Injects the user before routes are mounted so authenticate/requireRole see it.
 */
function createAppWithUser(
  userId: string,
  role: 'CLIENT' | 'AGENT' | 'ADMIN' | 'WORKER',
) {
  const app = express();
  app.use(express.json());

  // Inject a mock principal before routes
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId, authUserId: 'mock-auth-id', role };
    next();
  });

  app.use('/api/v1/workers', workerRoutes);
  app.use(errorMiddleware);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)('Week 4 — Worker Profile Claim Flow', () => {
  beforeAll(async () => {
    await rawClient.connect();
  });

  afterAll(async () => {
    // Clean up all temporary records in reverse dependency order.
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

  // ─── Test 1: Successful claim ──────────────────────────────────────────

  it('1. should claim an unclaimed worker profile when phone and CNIC last-4 match', async () => {
    const phone = '+923001000001';
    const cnic = '3520212345671';
    const workerId = await createTempWorker(phone, cnic);
    const userId = await createTempUser(phone, 'CLIENT');

    const app = createAppWithUser(userId, 'CLIENT');
    const res = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5671' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.workerProfileId).toBe(workerId);
    expect(res.body.data.claimStatus).toBe('CLAIMED');
    expect(res.body.data.userRole).toBe('WORKER');
    expect(res.body.data.profileStatus).toBeDefined();
    // Must not expose CNIC
    expect(res.body.data.cnicNumber).toBeUndefined();
    expect(res.body.data.cnicLast4).toBeUndefined();
    // Must not expose phone
    expect(res.body.data.phone).toBeUndefined();

    // Verify the DB state
    const worker = await prisma.workerProfile.findUnique({
      where: { id: workerId },
      select: { userId: true },
    });
    expect(worker?.userId).toBe(userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    expect(user?.role).toBe('WORKER');
  });

  // ─── Test 2: Idempotent retry ──────────────────────────────────────────

  it('2. should be idempotent — same user retrying returns success', async () => {
    const phone = '+923001000002';
    const cnic = '3520212345672';
    const workerId = await createTempWorker(phone, cnic);
    const userId = await createTempUser(phone, 'CLIENT');

    const app = createAppWithUser(userId, 'CLIENT');

    // First claim
    const res1 = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5672' });
    expect(res1.status).toBe(200);
    expect(res1.body.data.workerProfileId).toBe(workerId);

    // Retry — should succeed (idempotent)
    const res2 = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5672' });
    expect(res2.status).toBe(200);
    expect(res2.body.data.workerProfileId).toBe(workerId);
    expect(res2.body.data.claimStatus).toBe('CLAIMED');
  });

  // ─── Test 3: Wrong CNIC last-4 ─────────────────────────────────────────

  it('3. should reject when CNIC last-4 does not match', async () => {
    const phone = '+923001000003';
    const cnic = '3520212345673';
    await createTempWorker(phone, cnic);
    const userId = await createTempUser(phone, 'CLIENT');

    const app = createAppWithUser(userId, 'CLIENT');
    const res = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '9999' }); // wrong

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // Generic message — must not reveal CNIC details
    const msg = res.body.message ?? '';
    expect(msg).not.toContain(cnic);
  });

  // ─── Test 4: Phone mismatch (no worker for phone) ──────────────────────

  it('4. should reject when no worker profile exists for the user phone', async () => {
    const workerPhone = '+923001000004';
    const userPhone = '+923001000099';
    await createTempWorker(workerPhone, '3520212345674');
    const userId = await createTempUser(userPhone, 'CLIENT');

    const app = createAppWithUser(userId, 'CLIENT');
    const res = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5674' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // ─── Test 5: Already claimed by another user ───────────────────────────

  it('5. should reject when the worker profile is already claimed by another user', async () => {
    const phone = '+923001000005';
    const cnic = '3520212345675';
    const workerId = await createTempWorker(phone, cnic);
    const claimant1Id = await createTempUser(phone, 'CLIENT');
    const claimant2Id = await createTempUser(phone + '9', 'CLIENT'); // different phone

    // Claimant 1 claims the worker
    const app1 = createAppWithUser(claimant1Id, 'CLIENT');
    const res1 = await request(app1)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5675' });
    expect(res1.status).toBe(200);

    // Claimant 2 has a different phone, so they won't find this worker.
    // But let's force the scenario: claimant 2 tries to claim by having
    // the same phone. We need a second worker with the same phone? No,
    // phone is unique. Instead, we manually set the worker's userId to
    // claimant2Id and have claimant1 try again.
    // Actually, the proper test: a second user with the SAME phone can't
    // exist (User.phone is unique). So we simulate by directly setting
    // userId on the worker to a different user.
    await prisma.workerProfile.update({
      where: { id: workerId },
      data: { userId: claimant2Id },
    });

    // Now claimant1 retries — should get conflict (already claimed by another)
    const res2 = await request(app1)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5675' });
    expect(res2.status).toBe(409);
    expect(res2.body.success).toBe(false);
  });

  // ─── Test 6: User already linked to a different worker ─────────────────

  it('6. should reject when the user is already linked to a different worker profile', async () => {
    const phone = '+923001000006';
    const cnic1 = '3520212345676';
    const cnic2 = '3520212345677';
    const worker1Id = await createTempWorker(phone, cnic1);
    // Second worker with a different phone (phone is unique)
    const worker2Id = await createTempWorker('+923001000066', cnic2);
    const userId = await createTempUser(phone, 'CLIENT');

    // Link user to worker1 directly
    await prisma.workerProfile.update({
      where: { id: worker1Id },
      data: { userId },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'WORKER' },
    });

    // Now user tries to claim worker2 — but their phone doesn't match worker2's phone.
    // So they'll get a 404 (no worker for their phone).
    // To properly test "already linked to a different worker", we need the
    // user's phone to match worker2. But phone is unique on User.
    // The real scenario: user is linked to worker1, then tries to claim
    // worker2 which has the same phone — impossible since phone is unique.
    //
    // Instead, test the existingLink check directly: user is linked to worker1,
    // and we try to claim a worker that has the same phone but different ID.
    // Since WorkerProfile.phone is unique, this can't happen either.
    //
    // The check is a defensive guard. Let's test it by having the user's
    // phone match worker2, but the user is already linked to worker1.
    // We update the user's phone to match worker2's phone.
    await prisma.user.update({
      where: { id: userId },
      data: { phone: '+923001000066' },
    });

    const app = createAppWithUser(userId, 'WORKER');
    const res = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5677' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  // ─── Test 7: Suspended worker ──────────────────────────────────────────

  it('7. should reject when the worker profile is suspended', async () => {
    const phone = '+923001000007';
    const cnic = '3520212345678';
    await createTempWorker(phone, cnic, {
      status: 'SUSPENDED',
      suspensionReason: 'Test suspension',
    });
    const userId = await createTempUser(phone, 'CLIENT');

    const app = createAppWithUser(userId, 'CLIENT');
    const res = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5678' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  // ─── Test 8: Missing cnicLast4 in body ─────────────────────────────────

  it('8. should reject when cnicLast4 is missing from the request body', async () => {
    const phone = '+923001000008';
    const userId = await createTempUser(phone, 'CLIENT');

    const app = createAppWithUser(userId, 'CLIENT');
    const res = await request(app).post('/api/v1/workers/claim').send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ─── Test 9: Invalid cnicLast4 format ──────────────────────────────────

  it('9. should reject when cnicLast4 is not exactly 4 digits', async () => {
    const phone = '+923001000009';
    const userId = await createTempUser(phone, 'CLIENT');

    const app = createAppWithUser(userId, 'CLIENT');

    // Too short
    const res1 = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '123' });
    expect(res1.status).toBe(400);

    // Too long
    const res2 = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '12345' });
    expect(res2.status).toBe(400);

    // Non-numeric
    const res3 = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: 'abcd' });
    expect(res3.status).toBe(400);
  });

  // ─── Test 10: Response DTO shape ───────────────────────────────────────

  it('10. should return only safe fields in the response DTO', async () => {
    const phone = '+923001000010';
    const cnic = '3520212345679';
    await createTempWorker(phone, cnic);
    const userId = await createTempUser(phone, 'CLIENT');

    const app = createAppWithUser(userId, 'CLIENT');
    const res = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '5679' });

    expect(res.status).toBe(200);
    const data = res.body.data;

    // Allowed fields
    expect(data).toHaveProperty('workerProfileId');
    expect(data).toHaveProperty('workerName');
    expect(data).toHaveProperty('claimStatus');
    expect(data).toHaveProperty('userRole');
    expect(data).toHaveProperty('profileStatus');

    // Forbidden fields — must not be present
    expect(data).not.toHaveProperty('cnicNumber');
    expect(data).not.toHaveProperty('cnicLast4');
    expect(data).not.toHaveProperty('phone');
    expect(data).not.toHaveProperty('userId');
    expect(data).not.toHaveProperty('cnicFrontPath');
    expect(data).not.toHaveProperty('cnicBackPath');
    expect(data).not.toHaveProperty('referenceName');
    expect(data).not.toHaveProperty('referencePhone');
  });

  // ─── Test 11: User with no phone ───────────────────────────────────────

  it('11. should reject when the authenticated user has no phone number', async () => {
    const idx = tempUserIds.length;
    const user = await prisma.user.create({
      data: {
        // No phone
        email: `${PREFIX}-nophone-${idx}@test.local`,
        role: 'CLIENT',
      },
      select: { id: true },
    });
    tempUserIds.push(user.id);

    const app = createAppWithUser(user.id, 'CLIENT');
    const res = await request(app)
      .post('/api/v1/workers/claim')
      .send({ cnicLast4: '1234' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
