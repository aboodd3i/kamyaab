/**
 * Week 4 — Claimed-Worker Invitation Accept/Reject Flow Integration Tests
 *
 * Verifies that an authenticated user who has claimed a WorkerProfile through
 * POST /api/v1/workers/claim can correctly use the invitation accept/reject
 * flow via GET /api/v1/invitations/pending and POST /api/v1/invitations/:id/respond.
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

// Mock the auth middleware — authenticate is a no-op (test injects req.user),
// but requireRole uses the real implementation so it throws real AppError
// instances that the errorMiddleware can handle correctly.
vi.mock('../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth')>(
    '../middleware/auth',
  );
  return {
    ...actual,
    authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
  };
});

// Mock supabase — not used in invitation routes
vi.mock('../lib/supabase', () => ({ supabase: {} }));

// ─── Imports (only loaded after mocks are set up) ──────────────────────────

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import invitationRoutes from '../routes/invitations';
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

async function createTempUser(
  role: 'CLIENT' | 'AGENT' | 'ADMIN' | 'WORKER' = 'CLIENT',
  phone?: string,
): Promise<string> {
  const idx = tempUserIds.length;
  const user = await prisma.user.create({
    data: {
      phone: phone ?? `${PREFIX}-user-${idx}`,
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

/**
 * Create a temp approved WorkerProfile that is claimed by the given userId.
 * The worker has a category and service area.
 */
async function createTempClaimedWorker(
  userId: string,
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
      userId,
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

/**
 * Create a temp unclaimed approved WorkerProfile (userId = null).
 */
async function createTempUnclaimedWorker(
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
  targetWorkerId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const idx = tempJobRequestIds.length;
  const job = await prisma.jobRequest.create({
    data: {
      clientId,
      categoryId,
      areaId,
      targetWorkerId,
      description: `${PREFIX}-job-desc-${idx} — need help with repair work`,
      urgency: 'FLEXIBLE',
      type: 'SPECIFIC_WORKER',
      status: 'WORKER_CONTACTED',
      submittedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
      smsSentAt: new Date(),
      ...overrides,
    },
    select: { id: true },
  });
  tempInvitationIds.push(inv.id);
  return inv.id;
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

  app.use('/api/v1/invitations', invitationRoutes);
  app.use(errorMiddleware);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 4 — Claimed-Worker Invitation Accept/Reject Flow',
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

    // ─── Test 1: Claimed worker can list pending invitations ────────────

    it('1. a claimed worker (role WORKER) can GET /pending and see their invitations', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId);
      const invitationId = await createTempInvitation(jobId, workerId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app).get('/api/v1/invitations/pending');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);

      const inv = res.body.data.find((i: { id: string }) => i.id === invitationId);
      expect(inv).toBeDefined();
      expect(inv.status).toBe('PENDING');
      expect(inv.jobRequest.id).toBe(jobId);
      expect(inv.jobRequest.status).toBe('WORKER_CONTACTED');
    });

    // ─── Test 2: Non-WORKER roles are forbidden from GET /pending ──────

    it('2. a CLIENT user cannot GET /pending (403)', async () => {
      const clientUserId = await createTempUser('CLIENT');

      const app = createAppWithUser(clientUserId, 'CLIENT');
      const res = await request(app).get('/api/v1/invitations/pending');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('3. an AGENT user cannot GET /pending (403)', async () => {
      const agentUserId = await createTempUser('AGENT');

      const app = createAppWithUser(agentUserId, 'AGENT');
      const res = await request(app).get('/api/v1/invitations/pending');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 4: User without claimed worker profile gets 404 ───────────

    it('4. a WORKER user with no linked WorkerProfile gets 404 on GET /pending', async () => {
      const workerUserId = await createTempUser('WORKER');

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app).get('/api/v1/invitations/pending');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 5: Claimed worker can accept an invitation ───────────────

    it('5. a claimed worker can accept their invitation and a booking is created', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId);
      const invitationId = await createTempInvitation(jobId, workerId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACCEPTED');
      expect(res.body.data.booking).toBeDefined();
      expect(res.body.data.booking.id).toBeDefined();
      expect(res.body.data.booking.status).toBe('CONFIRMED');
      expect(res.body.data.booking.confirmedAt).toBeDefined();

      // Verify DB state
      const invitation = await prisma.jobInvitation.findUnique({
        where: { id: invitationId },
        select: { status: true },
      });
      expect(invitation?.status).toBe('ACCEPTED');

      const job = await prisma.jobRequest.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      expect(job?.status).toBe('ACCEPTED');

      const booking = await prisma.booking.findUnique({
        where: { invitationId },
        select: { id: true, status: true },
      });
      expect(booking).toBeDefined();
      expect(booking?.status).toBe('CONFIRMED');
      tempBookingIds.push(booking!.id);
    });

    // ─── Test 6: Claimed worker can reject an invitation ───────────────

    it('6. a claimed worker can reject their invitation and job reverts to DRAFT', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId);
      const invitationId = await createTempInvitation(jobId, workerId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'REJECTED' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('REJECTED');

      // Verify DB state
      const invitation = await prisma.jobInvitation.findUnique({
        where: { id: invitationId },
        select: { status: true },
      });
      expect(invitation?.status).toBe('REJECTED');

      const job = await prisma.jobRequest.findUnique({
        where: { id: jobId },
        select: { status: true, targetWorkerId: true },
      });
      expect(job?.status).toBe('DRAFT');
      expect(job?.targetWorkerId).toBeNull();

      // No booking should have been created
      const booking = await prisma.booking.findUnique({
        where: { invitationId },
      });
      expect(booking).toBeNull();
    });

    // ─── Test 7: Cannot respond to another worker's invitation ─────────

    it('7. a claimed worker cannot respond to an invitation belonging to another worker', async () => {
      const worker1UserId = await createTempUser('WORKER');
      const worker2UserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const worker1Id = await createTempClaimedWorker(worker1UserId, categoryId, areaId);
      const worker2Id = await createTempClaimedWorker(worker2UserId, categoryId, areaId);

      // Invitation is for worker2, but worker1 tries to respond
      const jobId = await createTempJobRequest(clientId, categoryId, areaId, worker2Id);
      const invitationId = await createTempInvitation(jobId, worker2Id);

      const app = createAppWithUser(worker1UserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 8: Idempotent acceptance — re-accepting returns the existing booking ──

    it('8. re-accepting an already ACCEPTED invitation returns HTTP 200 with the same booking (idempotent)', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId, {
        status: 'ACCEPTED',
      });
      const invitationId = await createTempInvitation(jobId, workerId, {
        status: 'ACCEPTED',
        respondedAt: new Date(),
      });

      // Create the booking that corresponds to the accepted invitation
      const booking = await prisma.booking.create({
        data: {
          jobRequestId: jobId,
          workerId,
          invitationId,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      });
      tempBookingIds.push(booking.id);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'ACCEPTED' });

      // Idempotent: HTTP 200, same booking returned
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACCEPTED');
      expect(res.body.data.booking).toBeDefined();
      expect(res.body.data.booking.id).toBe(booking.id);
      expect(res.body.data.booking.status).toBe('CONFIRMED');
    });

    // ─── Test 9: Cannot reject an already-accepted invitation ──────────

    it('9. cannot reject an invitation that is already ACCEPTED', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId, {
        status: 'ACCEPTED',
      });
      const invitationId = await createTempInvitation(jobId, workerId, {
        status: 'ACCEPTED',
        respondedAt: new Date(),
      });

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'REJECTED' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 10: Cannot respond to an already-rejected invitation ─────

    it('10. cannot respond to an invitation that is already REJECTED', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId, {
        status: 'DRAFT',
        targetWorkerId: null,
        submittedAt: null,
        expiresAt: null,
      });
      const invitationId = await createTempInvitation(jobId, workerId, {
        status: 'REJECTED',
        respondedAt: new Date(),
      });

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 11: Cannot respond to an expired invitation ──────────────

    it('11. cannot respond to an invitation whose job request has expired', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId, {
        expiresAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1 hour ago
      });
      const invitationId = await createTempInvitation(jobId, workerId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 12: Cannot respond to a non-existent invitation ──────────

    it('12. responding to a non-existent invitation returns 404', async () => {
      const workerUserId = await createTempUser('WORKER');
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${randomUUID()}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 13: Non-WORKER roles are forbidden from POST /:id/respond

    it('13. a CLIENT user cannot POST /:id/respond (403)', async () => {
      const clientUserId = await createTempUser('CLIENT');

      const app = createAppWithUser(clientUserId, 'CLIENT');
      const res = await request(app)
        .post(`/api/v1/invitations/${randomUUID()}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 14: WORKER without claimed profile gets 404 on respond ───

    it('14. a WORKER user with no linked WorkerProfile gets 404 on POST /:id/respond', async () => {
      const workerUserId = await createTempUser('WORKER');

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${randomUUID()}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 15: Invalid status in body is rejected ───────────────────

    it('15. an invalid status value in the request body is rejected (400)', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId);
      const invitationId = await createTempInvitation(jobId, workerId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'INVALID' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 16: Missing status in body is rejected ───────────────────

    it('16. a missing status field in the request body is rejected (400)', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId);
      const invitationId = await createTempInvitation(jobId, workerId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // ─── Test 17: Acceptance response does not leak sensitive fields ───

    it('17. the acceptance response does not contain CNIC, phone, paths, or reference info', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId, {
        cnicNumber: '3520299999999',
        cnicFrontPath: 'secret/cnic/front.jpg',
        cnicBackPath: 'secret/cnic/back.jpg',
        referenceName: 'SecretRef',
        referencePhone: '+923009999999',
      });

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId);
      const invitationId = await createTempInvitation(jobId, workerId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app)
        .post(`/api/v1/invitations/${invitationId}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);

      const json = JSON.stringify(res.body.data);
      // Must not contain sensitive worker fields
      expect(json).not.toContain('3520299999999');
      expect(json).not.toContain('secret/cnic/front.jpg');
      expect(json).not.toContain('secret/cnic/back.jpg');
      expect(json).not.toContain('SecretRef');
      expect(json).not.toContain('+923009999999');

      // The booking DTO should only have id, status, confirmedAt
      expect(res.body.data.booking).toHaveProperty('id');
      expect(res.body.data.booking).toHaveProperty('status');
      expect(res.body.data.booking).toHaveProperty('confirmedAt');
      expect(res.body.data.booking).not.toHaveProperty('clientPhone');
      expect(res.body.data.booking).not.toHaveProperty('workerPhone');
      expect(res.body.data.booking).not.toHaveProperty('workerId');

      // Verify booking exists for cleanup
      const booking = await prisma.booking.findUnique({
        where: { invitationId },
        select: { id: true },
      });
      if (booking) tempBookingIds.push(booking.id);
    });

    // ─── Test 18: Pending invitations list does not leak sensitive data

    it('18. the pending invitations list does not contain sensitive worker or client data', async () => {
      const workerUserId = await createTempUser('WORKER');
      const clientUserId = await createTempUser('CLIENT', '+923008888888');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId, {
        cnicNumber: '3520288888881',
        cnicFrontPath: 'secret/cnic/front18.jpg',
        cnicBackPath: 'secret/cnic/back18.jpg',
        referenceName: 'SecretRef18',
        referencePhone: '+923008888881',
      });

      const jobId = await createTempJobRequest(clientId, categoryId, areaId, workerId);
      await createTempInvitation(jobId, workerId);

      const app = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(app).get('/api/v1/invitations/pending');

      expect(res.status).toBe(200);

      const json = JSON.stringify(res.body.data);
      // Must not contain sensitive worker fields
      expect(json).not.toContain('3520288888881');
      expect(json).not.toContain('secret/cnic/front18.jpg');
      expect(json).not.toContain('secret/cnic/back18.jpg');
      expect(json).not.toContain('SecretRef18');
      expect(json).not.toContain('+923008888881');
      // Must not contain client phone
      expect(json).not.toContain('+923008888888');
    });
  },
);
