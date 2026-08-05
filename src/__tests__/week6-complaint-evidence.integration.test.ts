/**
 * Week 6 — Complaint Evidence File Upload Integration Tests
 *
 * Tests the complaint evidence file upload feature:
 *   1.  File a complaint with evidence files → 201, evidenceFilePaths populated
 *   2.  File a complaint without evidence → 201, evidenceFilePaths = []
 *   3.  Reject more than 5 files → 400
 *   4.  Reject unsupported MIME type → 400
 *   5.  Reject file exceeding 5 MiB → 400
 *   6.  Missing reason → 400
 *   7.  Missing bookingId → 400
 *   8.  Non-existent booking → 404
 *   9.  Evidence paths are storage paths (not public URLs)
 *   10. Complaint DTO includes evidenceFilePaths array
 *   11. Admin can resolve a complaint that has evidence files
 *
 * Uses a real PostgreSQL database with mocked auth + storage adapter.
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
    supabaseServiceRoleKey: 'dummy-service-role-key',
    port: 3000,
    nodeEnv: 'test',
    isProduction: false,
  },
}));

// Set env vars needed by the route layer
process.env.SUPABASE_COMPLAINT_BUCKET = 'test-complaint-bucket';

vi.mock('../middleware/auth', async () => {
  const { AppError, ErrorCode } = await vi.importActual<typeof import('../lib/errors')>('../lib/errors');
  return {
    authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
    requireRole: (...roles: string[]) =>
      (req: Request, _res: Response, next: NextFunction) => {
        if (!req.user || !roles.includes(req.user.role)) {
          return next(
            new AppError(403, ErrorCode.AUTH_FORBIDDEN, 'Insufficient permissions'),
          );
        }
        next();
      },
  };
});

vi.mock('../lib/supabase', () => ({ supabase: {} }));

// Mock the storage adapter with an in-memory fake — no real Supabase calls
const fakeUploadedPaths: string[] = [];
vi.mock('../services/supabaseStorageAdapter', () => ({
  createSupabaseStorageAdapter: () => ({
    uploadPrivateObject: async (path: string) => {
      fakeUploadedPaths.push(path);
      return { path };
    },
    removePrivateObject: async (path: string) => {
      const idx = fakeUploadedPaths.indexOf(path);
      if (idx >= 0) fakeUploadedPaths.splice(idx, 1);
    },
  }),
}));

// ─── Imports ───────────────────────────────────────────────────────────────

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import complaintRoutes from '../routes/complaints';
import bookingRoutes from '../routes/bookings';
import jobRequestRoutes from '../routes/jobRequests';
import invitationRoutes from '../routes/invitations';
import { errorMiddleware } from '../lib/errors';

// ─── Setup ─────────────────────────────────────────────────────────────────

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });

const NS = randomUUID();
const PREFIX = `__test_${NS.substring(0, 8)}`;

const tempUserIds: string[] = [];
const tempClientProfileIds: string[] = [];
const tempWorkerIds: string[] = [];
const tempCategoryIds: string[] = [];
const tempAreaIds: string[] = [];
const tempJobRequestIds: string[] = [];
const tempInvitationIds: string[] = [];
const tempBookingIds: string[] = [];
const tempComplaintIds: string[] = [];

// ─── Helpers ───────────────────────────────────────────────────────────────

async function createTempUser(
  role: 'CLIENT' | 'AGENT' | 'ADMIN' = 'CLIENT',
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

async function createTempClaimedWorker(
  userId: string,
  categoryId: string,
  areaId: string,
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
    },
    select: { id: true },
  });
  tempWorkerIds.push(worker.id);
  return worker.id;
}

/**
 * Create a full booking flow and complete it:
 * client creates draft → submits → worker accepts → client completes.
 */
async function createCompletedBooking(): Promise<{
  clientUserId: string;
  workerUserId: string;
  workerId: string;
  jobRequestId: string;
  invitationId: string;
  bookingId: string;
}> {
  const clientUserId = await createTempUser('CLIENT');
  await createTempClientProfile(clientUserId);
  const categoryId = await createTempCategory();
  const areaId = await createTempArea();
  const workerUserId = await createTempUser('CLIENT');
  const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

  const clientApp = createAppWithUser(clientUserId, 'CLIENT');
  const draftRes = await request(clientApp)
    .post('/api/v1/job-requests')
    .send({
      categoryId,
      areaId,
      description: `${PREFIX} — need plumbing service`,
    });
  const jobRequestId = draftRes.body.data.id;
  tempJobRequestIds.push(jobRequestId);

  await request(clientApp)
    .post(`/api/v1/job-requests/${jobRequestId}/submit`)
    .send({ targetWorkerId: workerId });

  const invitation = await prisma.jobInvitation.findFirst({
    where: { jobRequestId },
    select: { id: true },
  });
  tempInvitationIds.push(invitation!.id);

  const workerApp = createAppWithUser(workerUserId, 'WORKER');
  const acceptRes = await request(workerApp)
    .post(`/api/v1/invitations/${invitation!.id}/respond`)
    .send({ status: 'ACCEPTED' });

  const bookingId = acceptRes.body.data.booking.id;
  tempBookingIds.push(bookingId);

  // Complete the booking
  await request(clientApp).post(`/api/v1/bookings/${bookingId}/complete`).send();

  return {
    clientUserId,
    workerUserId,
    workerId,
    jobRequestId,
    invitationId: invitation!.id,
    bookingId,
  };
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

  app.use('/api/v1/job-requests', jobRequestRoutes);
  app.use('/api/v1/invitations', invitationRoutes);
  app.use('/api/v1/bookings', bookingRoutes);
  app.use('/api/v1/complaints', complaintRoutes);
  app.use(errorMiddleware);
  return app;
}

/** Create a fake image buffer for testing. */
function fakeImageBuffer(size = 1024): Buffer {
  return Buffer.alloc(size, 0xff); // Simple buffer filled with 0xff
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 6 — Complaint Evidence Files',
  () => {
    beforeAll(async () => {
      await rawClient.connect();
    });

    afterAll(async () => {
      // Clean up in reverse dependency order
      if (tempComplaintIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "Complaint" WHERE "id" = ANY($1::text[])`,
          [tempComplaintIds],
        );
      }
      if (tempBookingIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "Complaint" WHERE "bookingId" = ANY($1::text[])`,
          [tempBookingIds],
        );
        await rawClient.query(
          `DELETE FROM "Review" WHERE "bookingId" = ANY($1::text[])`,
          [tempBookingIds],
        );
      }
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
          `DELETE FROM "AuditLog" WHERE "actorUserId" = ANY($1::text[])`,
          [tempUserIds],
        );
        await rawClient.query(
          `DELETE FROM "User" WHERE "id" = ANY($1::text[])`,
          [tempUserIds],
        );
      }

      await rawClient.end();
      await prisma.$disconnect();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 1. File a complaint with evidence files
    // ═══════════════════════════════════════════════════════════════════════

    it('1. file a complaint with evidence files → 201, evidenceFilePaths populated', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId)
        .field('reason', 'Worker did not show up')
        .attach('evidence', fakeImageBuffer(1024), 'evidence1.jpg', 'image/jpeg')
        .attach('evidence', fakeImageBuffer(2048), 'evidence2.png', 'image/png');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.evidenceFilePaths).toHaveLength(2);
      tempComplaintIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. File a complaint without evidence
    // ═══════════════════════════════════════════════════════════════════════

    it('2. file a complaint without evidence → 201, evidenceFilePaths = []', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId)
        .field('reason', 'Poor quality work');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.evidenceFilePaths).toEqual([]);
      tempComplaintIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. Reject more than 5 files
    // ═══════════════════════════════════════════════════════════════════════

    it('3. reject more than 5 evidence files → 400', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      // multer is configured with maxCount=5, so it will reject with 400
      // before we even reach our handler
      let req = request(app)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId)
        .field('reason', 'Too many files');

      for (let i = 0; i < 6; i++) {
        req = req.attach('evidence', fakeImageBuffer(512), `file${i}.jpg`, 'image/jpeg');
      }

      const res = await req;
      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4. Reject unsupported MIME type
    // ═══════════════════════════════════════════════════════════════════════

    it('4. reject unsupported MIME type → 400', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId)
        .field('reason', 'Bad file type')
        .attach('evidence', fakeImageBuffer(512), 'file.txt', 'text/plain');

      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 5. Reject file exceeding 5 MiB
    // ═══════════════════════════════════════════════════════════════════════

    it('5. reject file exceeding 5 MiB → 400', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      // 6 MiB buffer — exceeds the 5 MiB limit
      const res = await request(app)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId)
        .field('reason', 'File too large')
        .attach('evidence', fakeImageBuffer(6 * 1024 * 1024), 'big.jpg', 'image/jpeg');

      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 6. Missing reason → 400
    // ═══════════════════════════════════════════════════════════════════════

    it('6. missing reason → 400', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId);

      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 7. Missing bookingId → 400
    // ═══════════════════════════════════════════════════════════════════════

    it('7. missing bookingId → 400', async () => {
      const { clientUserId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .field('reason', 'No booking ID');

      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 8. Non-existent booking → 404
    // ═══════════════════════════════════════════════════════════════════════

    it('8. non-existent booking → 404', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .field('bookingId', randomUUID())
        .field('reason', 'Non-existent booking');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 9. Evidence paths are storage paths (not public URLs)
    // ═══════════════════════════════════════════════════════════════════════

    it('9. evidence paths are storage paths (not public URLs)', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId)
        .field('reason', 'Check paths')
        .attach('evidence', fakeImageBuffer(512), 'evidence.jpg', 'image/jpeg');

      expect(res.status).toBe(201);
      const paths: string[] = res.body.data.evidenceFilePaths;
      expect(paths).toHaveLength(1);
      // Storage paths should start with "complaints/" not "http"
      expect(paths[0]).toMatch(/^complaints\//);
      expect(paths[0]).not.toMatch(/^https?:\/\//);
      tempComplaintIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 10. Complaint DTO includes evidenceFilePaths array
    // ═══════════════════════════════════════════════════════════════════════

    it('10. complaint DTO includes evidenceFilePaths array', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(app)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId)
        .field('reason', 'DTO check')
        .attach('evidence', fakeImageBuffer(512), 'evidence.jpg', 'image/jpeg');
      tempComplaintIds.push(fileRes.body.data.id);

      // Fetch by ID — DTO should include evidenceFilePaths
      const getRes = await request(app).get(
        `/api/v1/complaints/${fileRes.body.data.id}`,
      );

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.evidenceFilePaths).toBeDefined();
      expect(Array.isArray(getRes.body.data.evidenceFilePaths)).toBe(true);
      expect(getRes.body.data.evidenceFilePaths).toHaveLength(1);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 11. Admin can resolve a complaint that has evidence files
    // ═══════════════════════════════════════════════════════════════════════

    it('11. admin can resolve a complaint that has evidence files', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .field('bookingId', bookingId)
        .field('reason', 'Need resolution with evidence')
        .attach('evidence', fakeImageBuffer(512), 'evidence.jpg', 'image/jpeg');
      tempComplaintIds.push(fileRes.body.data.id);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'RESOLVED', resolution: 'Investigated evidence and resolved' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('RESOLVED');
      // Evidence paths should still be present after resolution
      expect(res.body.data.evidenceFilePaths).toHaveLength(1);
    });
  },
);
