/**
 * Week 4 — My Jobs Contact-Release Gating Integration Tests
 *
 * Verifies that GET /api/v1/job-requests/mine does not leak worker
 * contact information before invitation acceptance, and only releases
 * it after a booking (server-controlled) has been created.
 *
 * Uses a real PostgreSQL database (no Prisma mocks) with mocked auth
 * middleware (same pattern as workers.test.ts) to bypass Supabase.
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
    'Integration tests skipped: set RUN_DB_INTEGRATION_TESTS=true and ensure NODE_ENV is not production.'
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
  // We can't import the real module here (mocks aren't set up yet),
  // so we create lightweight stand-ins that the mock factory uses.
  // The real error middleware in createApp will handle formatting.
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
// but requireRole uses the real role-checking logic.
vi.mock('../middleware/auth', () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: (...roles: string[]) =>
    (req: Request, _res: Response, next: NextFunction) => {
      if (!req.user || !roles.includes(req.user.role)) {
        return next(new mockAppError(403, mockErrorCode.AUTH_FORBIDDEN, 'Insufficient permissions'));
      }
      next();
    },
}));

// Mock supabase — not used in job request routes
vi.mock('../lib/supabase', () => ({ supabase: {} }));

// ─── Imports (only loaded after mocks are set up) ──────────────────────────

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { findForbiddenMyJobKey } from '../lib/myJobsDto';
import jobRequestRoutes from '../routes/jobRequests';
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
const tempClientProfileIds: string[] = [];
const tempWorkerIds: string[] = [];
const tempCategoryIds: string[] = [];
const tempAreaIds: string[] = [];
const tempJobRequestIds: string[] = [];
const tempInvitationIds: string[] = [];
const tempBookingIds: string[] = [];

// ─── Helpers ───────────────────────────────────────────────────────────────

async function createTempUser(role: 'CLIENT' | 'AGENT' | 'ADMIN' = 'CLIENT'): Promise<string> {
  const idx = tempUserIds.length;
  const user = await prisma.user.create({
    data: {
      phone: `${PREFIX}-user-${idx}`,
      email: `${PREFIX}-user-${idx}@test.local`,
      role,
    },
    select: { id: true },
  });
  tempUserIds.push(user.id);
  return user.id;
}

async function createTempClientProfile(userId: string): Promise<string> {
  const idx = tempClientProfileIds.length;
  const profile = await prisma.clientProfile.create({
    data: { userId, name: `${PREFIX}-client-${idx}` },
    select: { id: true },
  });
  tempClientProfileIds.push(profile.id);
  return profile.id;
}

async function createTempCategory(): Promise<string> {
  const idx = tempCategoryIds.length;
  const cat = await prisma.category.create({
    data: { name: `${PREFIX}-cat-${idx}` },
    select: { id: true },
  });
  tempCategoryIds.push(cat.id);
  return cat.id;
}

async function createTempArea(): Promise<string> {
  const idx = tempAreaIds.length;
  const area = await prisma.area.create({
    data: { name: `${PREFIX}-area-${idx}`, slug: `${PREFIX}-area-${idx}` },
    select: { id: true },
  });
  tempAreaIds.push(area.id);
  return area.id;
}

async function createTempApprovedWorker(
  categoryId: string,
  areaId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const idx = tempWorkerIds.length;
  const worker = await prisma.workerProfile.create({
    data: {
      name: `${PREFIX}-worker-${idx}`,
      phone: `${PREFIX}-phone-${idx}`,
      status: 'APPROVED',
      cnicNumber: `${PREFIX}-cnic-${idx}`,
      cnicFrontPath: `secret/path/front-${idx}.jpg`,
      cnicBackPath: `secret/path/back-${idx}.jpg`,
      referenceName: `${PREFIX}-ref-${idx}`,
      referencePhone: `${PREFIX}-ref-phone-${idx}`,
      categories: { create: [{ categoryId }] },
      serviceAreas: { create: [{ areaId }] },
      ...overrides,
    },
    select: { id: true },
  });
  tempWorkerIds.push(worker.id);
  return worker.id;
}

async function createTempJobRequest(
  clientId: string,
  categoryId: string,
  areaId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const idx = tempJobRequestIds.length;
  const job = await prisma.jobRequest.create({
    data: {
      clientId,
      categoryId,
      areaId,
      description: `${PREFIX}-job-desc-${idx} — need help with repair work`,
      urgency: 'FLEXIBLE',
      type: 'SPECIFIC_WORKER',
      status: 'DRAFT',
      ...overrides,
    },
    select: { id: true },
  });
  tempJobRequestIds.push(job.id);
  return job.id;
}

async function createTempInvitation(
  jobRequestId: string,
  workerId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const inv = await prisma.jobInvitation.create({
    data: {
      jobRequestId,
      workerId,
      status: 'PENDING',
      ...overrides,
    },
    select: { id: true },
  });
  tempInvitationIds.push(inv.id);
  return inv.id;
}

async function createTempBooking(
  jobRequestId: string,
  invitationId: string,
  workerId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const booking = await prisma.booking.create({
    data: {
      jobRequestId,
      invitationId,
      workerId,
      status: 'CONFIRMED',
      workerPhone: `${PREFIX}-released-phone`,
      clientPhone: `${PREFIX}-client-phone`,
      ...overrides,
    },
    select: { id: true },
  });
  tempBookingIds.push(booking.id);
  return booking.id;
}

/**
 * Create an Express app with a forced auth principal (bypasses Supabase).
 * Injects the user before routes are mounted so requireRole sees the role.
 */
function createAppWithUser(userId: string, role: 'CLIENT' | 'AGENT' | 'ADMIN') {
  const app = express();
  app.use(express.json());

  // Inject a mock principal before routes
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId, authUserId: 'mock-auth-id', role };
    next();
  });

  app.use('/api/v1/job-requests', jobRequestRoutes);
  app.use(errorMiddleware);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 4 — My Jobs Contact-Release Gating',
  () => {
    beforeAll(async () => {
      await rawClient.connect();
    });

    afterAll(async () => {
      // Clean up all temporary records in reverse dependency order.
      if (tempBookingIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "Booking" WHERE "id" = ANY($1::text[])`,
          [tempBookingIds],
        );
      }
      if (tempInvitationIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "JobInvitation" WHERE "id" = ANY($1::text[])`,
          [tempInvitationIds],
        );
      }
      if (tempJobRequestIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "JobRequest" WHERE "id" = ANY($1::text[])`,
          [tempJobRequestIds],
        );
      }
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
      if (tempClientProfileIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "ClientProfile" WHERE "id" = ANY($1::text[])`,
          [tempClientProfileIds],
        );
      }
      if (tempCategoryIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "Category" WHERE "id" = ANY($1::text[])`,
          [tempCategoryIds],
        );
      }
      if (tempAreaIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "Area" WHERE "id" = ANY($1::text[])`,
          [tempAreaIds],
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

    // ─── Test 1: Draft request does not expose worker phone ─────────────

    it('1. a draft specific-worker request does not expose the worker phone', async () => {
      const userId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(userId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempApprovedWorker(categoryId, areaId);

      // Create a draft job request targeting the worker (not yet submitted)
      const jobId = await createTempJobRequest(clientId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'DRAFT',
      });

      const app = createAppWithUser(userId, 'CLIENT');
      const res = await request(app).get('/api/v1/job-requests/mine');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const job = res.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.targetWorker).toBeDefined();
      expect(job.targetWorker.id).toBe(workerId);
      // Phone must be null before acceptance
      expect(job.targetWorker.phone).toBeNull();
      // No booking should exist yet
      expect(job.booking).toBeNull();
    });

    // ─── Test 2: Submitted (WORKER_CONTACTED) request does not expose phone ─

    it('2. a submitted request awaiting acceptance does not expose the worker phone', async () => {
      const userId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(userId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempApprovedWorker(categoryId, areaId);

      // Create a submitted job request with a PENDING invitation
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const jobId = await createTempJobRequest(clientId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'WORKER_CONTACTED',
        submittedAt: new Date(),
        expiresAt,
      });
      await createTempInvitation(jobId, workerId, {
        smsSentAt: new Date(),
      });

      const app = createAppWithUser(userId, 'CLIENT');
      const res = await request(app).get('/api/v1/job-requests/mine');

      expect(res.status).toBe(200);

      const job = res.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.status).toBe('WORKER_CONTACTED');
      expect(job.targetWorker).toBeDefined();
      // Phone must still be null — invitation is pending, no booking
      expect(job.targetWorker.phone).toBeNull();
      expect(job.booking).toBeNull();
    });

    // ─── Test 3: After acceptance (booking exists), phone IS exposed ─────

    it('3. after invitation acceptance creates a booking, phone is included', async () => {
      const userId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(userId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempApprovedWorker(categoryId, areaId);

      // Create an accepted job request with an accepted invitation and booking
      const jobId = await createTempJobRequest(clientId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'ACCEPTED',
        submittedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const invitationId = await createTempInvitation(jobId, workerId, {
        status: 'ACCEPTED',
        respondedAt: new Date(),
      });
      const workerPhone = `${PREFIX}-released-phone-3`;
      await createTempBooking(jobId, invitationId, workerId, {
        workerPhone,
      });

      const app = createAppWithUser(userId, 'CLIENT');
      const res = await request(app).get('/api/v1/job-requests/mine');

      expect(res.status).toBe(200);

      const job = res.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.status).toBe('ACCEPTED');
      expect(job.targetWorker).toBeDefined();
      // Phone should now be released
      expect(job.targetWorker.phone).toBe(workerPhone);
      expect(job.booking).toBeDefined();
      expect(job.booking.status).toBe('CONFIRMED');
    });

    // ─── Test 4: No sensitive fields appear in the response ─────────────

    it('4. no CNIC, address, storage path, or reference-contact fields appear', async () => {
      const userId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(userId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempApprovedWorker(categoryId, areaId, {
        cnicNumber: `${PREFIX}-sensitive-cnic`,
        cnicFrontPath: 'secret/cnic/front.jpg',
        cnicBackPath: 'secret/cnic/back.jpg',
        referenceName: `${PREFIX}-ref-name`,
        referencePhone: `${PREFIX}-ref-phone`,
      });

      // Create jobs in various states
      const draftJobId = await createTempJobRequest(clientId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'DRAFT',
      });

      const submittedJobId = await createTempJobRequest(clientId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'WORKER_CONTACTED',
        submittedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      await createTempInvitation(submittedJobId, workerId, { smsSentAt: new Date() });

      const acceptedJobId = await createTempJobRequest(clientId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'ACCEPTED',
        submittedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const accInvId = await createTempInvitation(acceptedJobId, workerId, {
        status: 'ACCEPTED',
        respondedAt: new Date(),
      });
      await createTempBooking(acceptedJobId, accInvId, workerId);

      const app = createAppWithUser(userId, 'CLIENT');
      const res = await request(app).get('/api/v1/job-requests/mine');

      expect(res.status).toBe(200);

      // Recursively scan every job item for forbidden keys
      for (const job of res.body.data) {
        const forbidden = findForbiddenMyJobKey(job);
        expect(forbidden).toBeNull();
      }
    });

    // ─── Test 5: Client cannot see another client's jobs ────────────────

    it('5. a client cannot retrieve another client\'s jobs or released contact info', async () => {
      // Client A — has an accepted job with released contact
      const userAId = await createTempUser('CLIENT');
      const clientAId = await createTempClientProfile(userAId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempApprovedWorker(categoryId, areaId);

      const jobAId = await createTempJobRequest(clientAId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'ACCEPTED',
        submittedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const invAId = await createTempInvitation(jobAId, workerId, {
        status: 'ACCEPTED',
        respondedAt: new Date(),
      });
      const releasedPhone = `${PREFIX}-released-phone-5`;
      await createTempBooking(jobAId, invAId, workerId, { workerPhone: releasedPhone });

      // Client B — should see none of Client A's jobs
      const userBId = await createTempUser('CLIENT');
      await createTempClientProfile(userBId);

      const appB = createAppWithUser(userBId, 'CLIENT');
      const res = await request(appB).get('/api/v1/job-requests/mine');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);

      // Client B should not see Client A's job
      const jobIds = res.body.data.map((j: { id: string }) => j.id);
      expect(jobIds).not.toContain(jobAId);

      // None of the data should contain Client A's released phone
      const json = JSON.stringify(res.body.data);
      expect(json).not.toContain(releasedPhone);
    });

    // ─── Test 6: Expired request does not expose phone ──────────────────

    it('6. an expired request does not expose the worker phone', async () => {
      const userId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(userId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempApprovedWorker(categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'EXPIRED',
        submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      });
      await createTempInvitation(jobId, workerId, {
        status: 'EXPIRED',
      });

      const app = createAppWithUser(userId, 'CLIENT');
      const res = await request(app).get('/api/v1/job-requests/mine');

      expect(res.status).toBe(200);

      const job = res.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.status).toBe('EXPIRED');
      expect(job.targetWorker.phone).toBeNull();
      expect(job.booking).toBeNull();
    });

    // ─── Test 7: Cancelled request does not expose phone ────────────────

    it('7. a cancelled request does not expose the worker phone', async () => {
      const userId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(userId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempApprovedWorker(categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, {
        targetWorkerId: workerId,
        status: 'CANCELLED',
        submittedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const app = createAppWithUser(userId, 'CLIENT');
      const res = await request(app).get('/api/v1/job-requests/mine');

      expect(res.status).toBe(200);

      const job = res.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.status).toBe('CANCELLED');
      expect(job.targetWorker.phone).toBeNull();
      expect(job.booking).toBeNull();
    });
  },
);
