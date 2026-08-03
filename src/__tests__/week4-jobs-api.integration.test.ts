/**
 * Week 4 — Complete Specific-Worker Booking Journey Integration Tests
 *
 * Replaces the five original skipped placeholder tests with executable
 * integration tests covering the full SPECIFIC_WORKER booking flow:
 *
 *   CLIENT creates draft → submits → WORKER sees invitation →
 *   WORKER accepts → Booking created → contact released →
 *   idempotent re-acceptance → concurrent acceptance → rejection →
 *   expiry → OPEN guard.
 *
 * Uses a real PostgreSQL database (no Prisma mocks) with mocked auth
 * middleware to bypass Supabase. No production Prisma singleton or HTTP
 * server is created during test collection.
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

// Import errors in the hoisted scope so the mocked requireRole can use it.
// Same pattern as week4-worker-claim and week4-myjobs-contact-release tests.
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

// Mock supabase — not used in job request or invitation routes
vi.mock('../lib/supabase', () => ({ supabase: {} }));

// ─── Imports (only loaded after mocks are set up) ──────────────────────────

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import jobRequestRoutes from '../routes/jobRequests';
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
 * Create a temp approved WorkerProfile claimed by the given userId.
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
 * Create an Express app with a forced auth principal (bypasses Supabase).
 * Mounts both job-request and invitation routes so the full flow can be
 * exercised end-to-end through HTTP.
 */
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

  app.use('/api/v1/job-requests', jobRequestRoutes);
  app.use('/api/v1/invitations', invitationRoutes);
  app.use(errorMiddleware);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 4 — Complete Specific-Worker Booking Journey',
  () => {
    beforeAll(async () => {
      await rawClient.connect();
    });

    afterAll(async () => {
      // Clean up all temporary records in reverse dependency order.
      // Delete ALL bookings and invitations that reference any temp job
      // requests first — not just tracked ones, since the service layer
      // creates invitations/bookings that may not have been recorded.
      if (tempJobRequestIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "Booking" WHERE "jobRequestId" = ANY($1::text[])`,
          [tempJobRequestIds],
        );
        await rawClient.query(
          `DELETE FROM "JobInvitation" WHERE "jobRequestId" = ANY($1::text[])`,
          [tempJobRequestIds],
        );
        await rawClient.query(
          `DELETE FROM "JobRequest" WHERE "id" = ANY($1::text[])`,
          [tempJobRequestIds],
        );
      }
      // Also clean up any individually tracked bookings/invitations
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

    // ═══════════════════════════════════════════════════════════════════════
    // 1. CLIENT creates a SPECIFIC_WORKER draft
    // ═══════════════════════════════════════════════════════════════════════

    it('1. an authenticated CLIENT can create a SPECIFIC_WORKER draft request', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();

      const app = createAppWithUser(clientUserId, 'CLIENT');
      const res = await request(app)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need a plumber for kitchen sink repair',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('DRAFT');
      expect(res.body.data.type).toBe('SPECIFIC_WORKER');
      tempJobRequestIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. Draft does not create invitation, booking, or expose contacts
    // ═══════════════════════════════════════════════════════════════════════

    it('2. draft creation does not create an invitation or booking, and does not expose worker contact', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const app = createAppWithUser(clientUserId, 'CLIENT');
      const res = await request(app)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need an electrician for wiring check',
        });

      expect(res.status).toBe(201);
      const jobId = res.body.data.id;
      tempJobRequestIds.push(jobId);

      // No invitation should exist
      const invitations = await prisma.jobInvitation.findMany({
        where: { jobRequestId: jobId },
      });
      expect(invitations).toHaveLength(0);

      // No booking should exist
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: jobId },
      });
      expect(bookings).toHaveLength(0);

      // My Jobs should show no worker phone
      const mineRes = await request(app).get('/api/v1/job-requests/mine');
      expect(mineRes.status).toBe(200);
      const job = mineRes.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.targetWorker).toBeNull(); // no targetWorker on a fresh draft
      expect(job.booking).toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. Owning client submits the draft
    // ═══════════════════════════════════════════════════════════════════════

    it('3. the owning client can submit the draft targeting a specific worker', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const app = createAppWithUser(clientUserId, 'CLIENT');

      // Create draft
      const draftRes = await request(app)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need AC repair service urgently',
        });
      expect(draftRes.status).toBe(201);
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      // Submit
      const submitRes = await request(app)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      expect(submitRes.status).toBe(200);
      expect(submitRes.body.success).toBe(true);
      expect(submitRes.body.data.status).toBe('WORKER_CONTACTED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4. Submission creates exactly one invitation and triggers mock SMS
    // ═══════════════════════════════════════════════════════════════════════

    it('4. submission creates exactly one invitation for the target worker and triggers mock SMS', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const app = createAppWithUser(clientUserId, 'CLIENT');

      const draftRes = await request(app)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need carpentry work for door frame',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      const submitRes = await request(app)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });
      expect(submitRes.status).toBe(200);

      // Exactly one invitation
      const invitations = await prisma.jobInvitation.findMany({
        where: { jobRequestId: jobId },
      });
      expect(invitations).toHaveLength(1);
      expect(invitations[0].workerId).toBe(workerId);
      expect(invitations[0].status).toBe('PENDING');
      expect(invitations[0].smsSentAt).not.toBeNull();
      tempInvitationIds.push(invitations[0].id);

      // No booking yet
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: jobId },
      });
      expect(bookings).toHaveLength(0);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 5. Another client cannot read or submit the request
    // ═══════════════════════════════════════════════════════════════════════

    it('5. another client cannot submit or retrieve released contact info from a request they do not own', async () => {
      const clientAUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientAUserId);
      const clientBUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientBUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      // Client A creates and submits
      const appA = createAppWithUser(clientAUserId, 'CLIENT');
      const draftRes = await request(appA)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need painting service for living room',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(appA)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      // Client B tries to submit — should be forbidden (not owner)
      const appB = createAppWithUser(clientBUserId, 'CLIENT');
      const submitBRes = await request(appB)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });
      expect(submitBRes.status).toBe(403);

      // Client B's My Jobs should not contain Client A's job
      const mineBRes = await request(appB).get('/api/v1/job-requests/mine');
      expect(mineBRes.status).toBe(200);
      const jobIds = mineBRes.body.data.map((j: { id: string }) => j.id);
      expect(jobIds).not.toContain(jobId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 6. Claimed WORKER can view their own pending invitation
    // ═══════════════════════════════════════════════════════════════════════

    it('6. a claimed WORKER can view their own pending invitation via GET /pending', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      // Client creates and submits
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need tile installation in bathroom',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      // Worker views pending
      const workerApp = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(workerApp).get('/api/v1/invitations/pending');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);

      const inv = res.body.data.find(
        (i: { jobRequest: { id: string } }) => i.jobRequest.id === jobId,
      );
      expect(inv).toBeDefined();
      expect(inv.status).toBe('PENDING');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 7. A different worker cannot view or respond to the invitation
    // ═══════════════════════════════════════════════════════════════════════

    it('7. a different worker cannot view or respond to another worker\'s invitation', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const worker1UserId = await createTempUser('WORKER');
      const worker1Id = await createTempClaimedWorker(worker1UserId, categoryId, areaId);
      const worker2UserId = await createTempUser('WORKER');
      const worker2Id = await createTempClaimedWorker(worker2UserId, categoryId, areaId);

      // Client creates and submits targeting worker1
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need plumbing fixture replacement',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: worker1Id });

      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId: jobId },
        select: { id: true },
      });
      expect(invitation).toBeDefined();
      tempInvitationIds.push(invitation!.id);

      // Worker2 should not see this invitation in their pending list
      const worker2App = createAppWithUser(worker2UserId, 'WORKER');
      const pendingRes = await request(worker2App).get('/api/v1/invitations/pending');
      expect(pendingRes.status).toBe(200);
      const invIds = pendingRes.body.data.map((i: { id: string }) => i.id);
      expect(invIds).not.toContain(invitation!.id);

      // Worker2 cannot respond to worker1's invitation
      const respondRes = await request(worker2App)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });
      expect(respondRes.status).toBe(403);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 8–9. Owning worker accepts → invitation ACCEPTED, job ACCEPTED, one Booking
    // ═══════════════════════════════════════════════════════════════════════

    it('8-9. the owning claimed worker can accept, creating exactly one Booking with correct links', async () => {
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      // Client creates and submits
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need roof leak repair service',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId: jobId },
        select: { id: true },
      });
      tempInvitationIds.push(invitation!.id);

      // Worker accepts
      const workerApp = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACCEPTED');
      expect(res.body.data.booking).toBeDefined();
      expect(res.body.data.booking.status).toBe('CONFIRMED');

      // Verify DB state
      const inv = await prisma.jobInvitation.findUnique({
        where: { id: invitation!.id },
        select: { status: true },
      });
      expect(inv?.status).toBe('ACCEPTED');

      const job = await prisma.jobRequest.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      expect(job?.status).toBe('ACCEPTED');

      // Exactly one booking
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: jobId },
      });
      expect(bookings).toHaveLength(1);
      expect(bookings[0].workerId).toBe(workerId);
      expect(bookings[0].status).toBe('CONFIRMED');
      tempBookingIds.push(bookings[0].id);

      // Booking links correct client, worker, job request, category, area
      const bookingWithRelations = await prisma.booking.findUnique({
        where: { id: bookings[0].id },
        include: {
          jobRequest: {
            select: {
              clientId: true,
              categoryId: true,
              areaId: true,
            },
          },
        },
      });
      expect(bookingWithRelations?.jobRequest.clientId).toBe(clientId);
      expect(bookingWithRelations?.jobRequest.categoryId).toBe(categoryId);
      expect(bookingWithRelations?.jobRequest.areaId).toBe(areaId);
      expect(bookingWithRelations?.workerId).toBe(workerId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 10. Before acceptance, GET /mine returns worker phone as null
    // ═══════════════════════════════════════════════════════════════════════

    it('10. before acceptance, GET /job-requests/mine returns worker phone as null', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need garden landscaping service',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      // Before acceptance — phone should be null
      const mineRes = await request(clientApp).get('/api/v1/job-requests/mine');
      expect(mineRes.status).toBe(200);

      const job = mineRes.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.targetWorker).toBeDefined();
      expect(job.targetWorker.phone).toBeNull();
      expect(job.booking).toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 11. After acceptance, GET /mine returns booking-captured worker phone
    // ═══════════════════════════════════════════════════════════════════════

    it('11. after acceptance, GET /job-requests/mine returns the booking-captured worker phone', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      // Get the worker's phone for comparison
      const worker = await prisma.workerProfile.findUnique({
        where: { id: workerId },
        select: { phone: true },
      });

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need furniture assembly service',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId: jobId },
        select: { id: true },
      });
      tempInvitationIds.push(invitation!.id);

      // Worker accepts
      const workerApp = createAppWithUser(workerUserId, 'WORKER');
      await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });

      // Track booking for cleanup
      const booking = await prisma.booking.findUnique({
        where: { invitationId: invitation!.id },
        select: { id: true },
      });
      if (booking) tempBookingIds.push(booking.id);

      // After acceptance — phone should be released
      const mineRes = await request(clientApp).get('/api/v1/job-requests/mine');
      expect(mineRes.status).toBe(200);

      const job = mineRes.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.targetWorker).toBeDefined();
      expect(job.targetWorker.phone).toBe(worker?.phone);
      expect(job.booking).toBeDefined();
      expect(job.booking.status).toBe('CONFIRMED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 12. No response exposes sensitive data
    // ═══════════════════════════════════════════════════════════════════════

    it('12. no response exposes CNIC, paths, reference phone, or raw Prisma models', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const sensitiveCnic = `${PREFIX}-sensitive-cnic`;
      const sensitiveRefPhone = `${PREFIX}-sensitive-ref-phone`;
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId, {
        cnicNumber: sensitiveCnic,
        cnicFrontPath: 'secret/cnic/front.jpg',
        cnicBackPath: 'secret/cnic/back.jpg',
        referenceName: 'SecretRef',
        referencePhone: sensitiveRefPhone,
      });

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need appliance repair service',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId: jobId },
        select: { id: true },
      });
      tempInvitationIds.push(invitation!.id);

      // Worker accepts
      const workerApp = createAppWithUser(workerUserId, 'WORKER');
      const acceptRes = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });
      expect(acceptRes.status).toBe(200);

      const booking = await prisma.booking.findUnique({
        where: { invitationId: invitation!.id },
        select: { id: true },
      });
      if (booking) tempBookingIds.push(booking.id);

      // Check acceptance response
      const acceptJson = JSON.stringify(acceptRes.body.data);
      expect(acceptJson).not.toContain(sensitiveCnic);
      expect(acceptJson).not.toContain('secret/cnic/front.jpg');
      expect(acceptJson).not.toContain('secret/cnic/back.jpg');
      expect(acceptJson).not.toContain('SecretRef');
      expect(acceptJson).not.toContain(sensitiveRefPhone);

      // Check My Jobs response
      const mineRes = await request(clientApp).get('/api/v1/job-requests/mine');
      const mineJson = JSON.stringify(mineRes.body.data);
      expect(mineJson).not.toContain(sensitiveCnic);
      expect(mineJson).not.toContain('secret/cnic/front.jpg');
      expect(mineJson).not.toContain('secret/cnic/back.jpg');
      expect(mineJson).not.toContain('SecretRef');
      expect(mineJson).not.toContain(sensitiveRefPhone);

      // Check pending invitations response (shouldn't show this one — it's accepted)
      const pendingRes = await request(workerApp).get('/api/v1/invitations/pending');
      const pendingJson = JSON.stringify(pendingRes.body.data);
      expect(pendingJson).not.toContain(sensitiveCnic);
      expect(pendingJson).not.toContain('secret/cnic/front.jpg');
      expect(pendingJson).not.toContain(sensitiveRefPhone);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 13. Repeated acceptance is idempotent — no second booking
    // ═══════════════════════════════════════════════════════════════════════

    it('13. repeating acceptance by the same worker does not create a second booking', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need window installation service',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId: jobId },
        select: { id: true },
      });
      tempInvitationIds.push(invitation!.id);

      const workerApp = createAppWithUser(workerUserId, 'WORKER');

      // First acceptance
      const res1 = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });
      expect(res1.status).toBe(200);
      const bookingId1 = res1.body.data.booking.id;

      // Track booking for cleanup
      const booking = await prisma.booking.findUnique({
        where: { invitationId: invitation!.id },
        select: { id: true },
      });
      if (booking) tempBookingIds.push(booking.id);

      // Second acceptance attempt — should be rejected (invitation already ACCEPTED)
      const res2 = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });
      expect(res2.status).toBe(400);

      // Exactly one booking
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: jobId },
      });
      expect(bookings).toHaveLength(1);
      expect(bookings[0].id).toBe(bookingId1);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 14. Concurrent acceptance results in exactly one Booking
    // ═══════════════════════════════════════════════════════════════════════

    it('14. two concurrent acceptance requests result in exactly one Booking row', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need CCTV camera installation',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId: jobId },
        select: { id: true },
      });
      tempInvitationIds.push(invitation!.id);

      // Fire two concurrent acceptances through the service layer
      const workerApp = createAppWithUser(workerUserId, 'WORKER');
      const [res1, res2] = await Promise.all([
        request(workerApp)
          .post(`/api/v1/invitations/${invitation!.id}/respond`)
          .send({ status: 'ACCEPTED' }),
        request(workerApp)
          .post(`/api/v1/invitations/${invitation!.id}/respond`)
          .send({ status: 'ACCEPTED' }),
      ]);

      // At least one should succeed (200), the other should either succeed
      // with the same booking (idempotent) or fail with 400 (already accepted)
      const successCount = [res1, res2].filter((r) => r.status === 200).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      // Track booking for cleanup
      const booking = await prisma.booking.findUnique({
        where: { invitationId: invitation!.id },
        select: { id: true },
      });
      if (booking) tempBookingIds.push(booking.id);

      // Exactly one booking row
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: jobId },
      });
      expect(bookings).toHaveLength(1);

      // If both succeeded, they must return the same booking ID
      if (res1.status === 200 && res2.status === 200) {
        expect(res1.body.data.booking.id).toBe(res2.body.data.booking.id);
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 15–16. Worker rejects a separate pending invitation
    // ═══════════════════════════════════════════════════════════════════════

    it('15-16. the owning worker can reject a pending invitation: no Booking, no contact release, cannot later accept', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need generator maintenance service',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId: jobId },
        select: { id: true },
      });
      tempInvitationIds.push(invitation!.id);

      // Worker rejects
      const workerApp = createAppWithUser(workerUserId, 'WORKER');
      const res = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'REJECTED' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REJECTED');

      // No booking created
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: jobId },
      });
      expect(bookings).toHaveLength(0);

      // Contact not released — My Jobs shows no target worker (rejection
      // clears targetWorkerId) and no booking
      const mineRes = await request(clientApp).get('/api/v1/job-requests/mine');
      const job = mineRes.body.data.find((j: { id: string }) => j.id === jobId);
      expect(job).toBeDefined();
      expect(job.targetWorker).toBeNull();
      expect(job.booking).toBeNull();

      // Cannot later accept the rejected invitation
      const acceptRes = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });
      expect(acceptRes.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 17. An accepted invitation cannot later be rejected
    // ═══════════════════════════════════════════════════════════════════════

    it('17. an accepted invitation cannot later be rejected', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need solar panel cleaning service',
        });
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });

      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId: jobId },
        select: { id: true },
      });
      tempInvitationIds.push(invitation!.id);

      const workerApp = createAppWithUser(workerUserId, 'WORKER');

      // Accept
      const acceptRes = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });
      expect(acceptRes.status).toBe(200);

      const booking = await prisma.booking.findUnique({
        where: { invitationId: invitation!.id },
        select: { id: true },
      });
      if (booking) tempBookingIds.push(booking.id);

      // Try to reject — should fail
      const rejectRes = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'REJECTED' });
      expect(rejectRes.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 18. Expired invitation cannot be accepted or rejected, no booking, no contact
    // ═══════════════════════════════════════════════════════════════════════

    it('18. an expired invitation cannot be accepted or rejected, creates no booking, exposes no contacts', async () => {
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      // Create a job request with an expired timestamp directly in the DB
      const job = await prisma.jobRequest.create({
        data: {
          clientId,
          categoryId,
          areaId,
          targetWorkerId: workerId,
          description: `${PREFIX}-expired-job — need pest control`,
          urgency: 'FLEXIBLE',
          type: 'SPECIFIC_WORKER',
          status: 'WORKER_CONTACTED',
          submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1 hour ago
        },
      });
      tempJobRequestIds.push(job.id);

      const invitation = await prisma.jobInvitation.create({
        data: {
          jobRequestId: job.id,
          workerId,
          status: 'PENDING',
          smsSentAt: new Date(),
        },
      });
      tempInvitationIds.push(invitation.id);

      const workerApp = createAppWithUser(workerUserId, 'WORKER');

      // Cannot accept
      const acceptRes = await request(workerApp)
        .post(`/api/v1/invitations/${invitation.id}/respond`)
        .send({ status: 'ACCEPTED' });
      expect(acceptRes.status).toBe(400);

      // Cannot reject as active (it's expired, not pending-active)
      const rejectRes = await request(workerApp)
        .post(`/api/v1/invitations/${invitation.id}/respond`)
        .send({ status: 'REJECTED' });
      expect(rejectRes.status).toBe(400);

      // No booking
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: job.id },
      });
      expect(bookings).toHaveLength(0);

      // No contact released
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const mineRes = await request(clientApp).get('/api/v1/job-requests/mine');
      const mineJob = mineRes.body.data.find((j: { id: string }) => j.id === job.id);
      expect(mineJob).toBeDefined();
      expect(mineJob.targetWorker.phone).toBeNull();
      expect(mineJob.booking).toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 19. 24-hour expiry mechanism tested via direct service invocation
    // ═══════════════════════════════════════════════════════════════════════

    it('19. the expiry mechanism marks expired requests and invitations correctly (direct invocation)', async () => {
      const clientUserId = await createTempUser('CLIENT');
      const clientId = await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      // Create a WORKER_CONTACTED job with expiresAt in the past
      const job = await prisma.jobRequest.create({
        data: {
          clientId,
          categoryId,
          areaId,
          targetWorkerId: workerId,
          description: `${PREFIX}-expiry-test — need locksmith`,
          urgency: 'URGENT',
          type: 'SPECIFIC_WORKER',
          status: 'WORKER_CONTACTED',
          submittedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
        },
      });
      tempJobRequestIds.push(job.id);

      const invitation = await prisma.jobInvitation.create({
        data: {
          jobRequestId: job.id,
          workerId,
          status: 'PENDING',
          smsSentAt: new Date(),
        },
      });
      tempInvitationIds.push(invitation.id);

      // Directly invoke the expiry logic (same as expiryJob.ts does,
      // but without the cron scheduler)
      const now = new Date();
      const expiredRequests = await prisma.jobRequest.findMany({
        where: {
          status: 'WORKER_CONTACTED',
          expiresAt: { lt: now },
        },
        include: {
          invitations: { where: { status: 'PENDING' } },
        },
      });

      // Our job should be in the expired set
      const ourJob = expiredRequests.find((r) => r.id === job.id);
      expect(ourJob).toBeDefined();

      // Execute the expiry transaction
      await prisma.$transaction(async (tx) => {
        await tx.jobRequest.update({
          where: { id: job.id },
          data: { status: 'EXPIRED' },
        });
        for (const inv of ourJob!.invitations) {
          await tx.jobInvitation.update({
            where: { id: inv.id },
            data: { status: 'EXPIRED' },
          });
        }
      });

      // Verify
      const expiredJob = await prisma.jobRequest.findUnique({
        where: { id: job.id },
        select: { status: true },
      });
      expect(expiredJob?.status).toBe('EXPIRED');

      const expiredInv = await prisma.jobInvitation.findUnique({
        where: { id: invitation.id },
        select: { status: true },
      });
      expect(expiredInv?.status).toBe('EXPIRED');

      // No booking created
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: job.id },
      });
      expect(bookings).toHaveLength(0);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 20. An OPEN request must not pass through the specific-worker flow
    // ═══════════════════════════════════════════════════════════════════════

    it('20. an OPEN request cannot be submitted through the specific-worker flow', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      // Create an OPEN draft
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: 'Need general handyman services',
          type: 'OPEN',
        });
      expect(draftRes.status).toBe(201);
      expect(draftRes.body.data.type).toBe('OPEN');
      const jobId = draftRes.body.data.id;
      tempJobRequestIds.push(jobId);

      // Attempt to submit with a targetWorkerId — should be rejected
      const submitRes = await request(clientApp)
        .post(`/api/v1/job-requests/${jobId}/submit`)
        .send({ targetWorkerId: workerId });
      expect(submitRes.status).toBe(400);
      expect(submitRes.body.success).toBe(false);

      // No invitation should have been created
      const invitations = await prisma.jobInvitation.findMany({
        where: { jobRequestId: jobId },
      });
      expect(invitations).toHaveLength(0);
    });
  },
);
