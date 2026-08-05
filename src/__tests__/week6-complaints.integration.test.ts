/**
 * Week 6 — Complaint Integration Tests
 *
 * Tests the complaints system:
 *   1.  Any authenticated user can file a complaint
 *   2.  Complaint status defaults to OPEN
 *   3.  Filed-by user is the authenticated user
 *   4.  Reason is stored correctly
 *   5.  Safe DTO returned (no forbidden fields)
 *   6.  Non-existent booking rejected (404)
 *   7.  Missing reason rejected (400)
 *   8.  Empty reason rejected (400)
 *   9.  Reason exceeding max length rejected (400)
 *   10. Admin can resolve a complaint
 *   11. Admin can dismiss a complaint
 *   12. Resolved complaint has resolvedByUserId set
 *   13. Resolved complaint has resolvedAt set
 *   14. Cannot resolve an already-resolved complaint (409)
 *   15. Non-admin cannot resolve a complaint (403)
 *   16. Non-existent complaint resolution rejected (404)
 *   17. Invalid resolution status rejected (400)
 *   18. Admin can list complaints
 *   19. Admin can filter complaints by status
 *   20. Non-admin cannot list complaints (403)
 *   21. Any authenticated user can get a complaint by ID
 *   22. Non-existent complaint lookup rejected (404)
 *
 * Also tests path-based review endpoints:
 *   23. POST /bookings/:id/reviews creates a CLIENT_TO_WORKER review
 *   24. POST /bookings/:id/reviews/worker creates a WORKER_TO_CLIENT review
 *   25. Worker rating is recalculated after a client review
 *
 * Uses a real PostgreSQL database with mocked auth middleware.
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

// ─── Imports ───────────────────────────────────────────────────────────────

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import complaintRoutes from '../routes/complaints';
import reviewRoutes from '../routes/reviews';
import bookingRoutes from '../routes/bookings';
import jobRequestRoutes from '../routes/jobRequests';
import invitationRoutes from '../routes/invitations';
import { errorMiddleware } from '../lib/errors';
import { findForbiddenComplaintKey } from '../lib/complaintDto';

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
const tempReviewIds: string[] = [];

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
 * Returns all entity IDs.
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
  app.use('/api/v1/reviews', reviewRoutes);
  app.use('/api/v1/complaints', complaintRoutes);
  app.use(errorMiddleware);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 6 — Complaints',
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
      if (tempReviewIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "Review" WHERE "id" = ANY($1::text[])`,
          [tempReviewIds],
        );
      }
      // Also clean up any reviews/complaints for our bookings
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
          `DELETE FROM "User" WHERE "id" = ANY($1::text[])`,
          [tempUserIds],
        );
      }

      await rawClient.end();
      await prisma.$disconnect();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 1. Any authenticated user can file a complaint
    // ═══════════════════════════════════════════════════════════════════════

    it('1. any authenticated user can file a complaint', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Worker did not show up' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      tempComplaintIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. Complaint status defaults to OPEN
    // ═══════════════════════════════════════════════════════════════════════

    it('2. complaint status defaults to OPEN', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Poor quality work' });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('OPEN');
      tempComplaintIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. Filed-by user is the authenticated user
    // ═══════════════════════════════════════════════════════════════════════

    it('3. filedByUserId is the authenticated user', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Unprofessional behavior' });

      expect(res.status).toBe(201);
      expect(res.body.data.filedByUserId).toBe(clientUserId);
      tempComplaintIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4. Reason is stored correctly
    // ═══════════════════════════════════════════════════════════════════════

    it('4. reason is stored correctly', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: '  Overcharged  ' });

      expect(res.status).toBe(201);
      expect(res.body.data.reason).toBe('Overcharged');
      tempComplaintIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 5. Safe DTO returned (no forbidden fields)
    // ═══════════════════════════════════════════════════════════════════════

    it('5. safe DTO returned with no forbidden fields', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Safety check' });

      expect(res.status).toBe(201);
      const forbidden = findForbiddenComplaintKey(res.body.data);
      expect(forbidden).toBeNull();
      tempComplaintIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 6. Non-existent booking rejected (404)
    // ═══════════════════════════════════════════════════════════════════════

    it('6. non-existent booking rejected', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId: randomUUID(), reason: 'Test' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 7. Missing reason rejected (400)
    // ═══════════════════════════════════════════════════════════════════════

    it('7. missing reason rejected', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId });

      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 8. Empty reason rejected (400)
    // ═══════════════════════════════════════════════════════════════════════

    it('8. empty reason rejected', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: '   ' });

      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 9. Reason exceeding max length rejected (400)
    // ═══════════════════════════════════════════════════════════════════════

    it('9. reason exceeding max length rejected', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'x'.repeat(2001) });

      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 10. Admin can resolve a complaint
    // ═══════════════════════════════════════════════════════════════════════

    it('10. admin can resolve a complaint', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Need resolution' });
      tempComplaintIds.push(fileRes.body.data.id);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'RESOLVED', resolution: 'Refunded the client' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('RESOLVED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 11. Admin can dismiss a complaint
    // ═══════════════════════════════════════════════════════════════════════

    it('11. admin can dismiss a complaint', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Unfounded complaint' });
      tempComplaintIds.push(fileRes.body.data.id);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'DISMISSED' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('DISMISSED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 12. Resolved complaint has resolvedByUserId set
    // ═══════════════════════════════════════════════════════════════════════

    it('12. resolved complaint has resolvedByUserId set', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Check resolvedBy' });
      tempComplaintIds.push(fileRes.body.data.id);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'RESOLVED', resolution: 'Fixed' });

      expect(res.status).toBe(200);
      expect(res.body.data.resolvedByUserId).toBe(adminUserId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 13. Resolved complaint has resolvedAt set
    // ═══════════════════════════════════════════════════════════════════════

    it('13. resolved complaint has resolvedAt set', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Check resolvedAt' });
      tempComplaintIds.push(fileRes.body.data.id);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'RESOLVED' });

      expect(res.status).toBe(200);
      expect(res.body.data.resolvedAt).not.toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 14. Cannot resolve an already-resolved complaint (409)
    // ═══════════════════════════════════════════════════════════════════════

    it('14. cannot resolve an already-resolved complaint', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Double resolve' });
      tempComplaintIds.push(fileRes.body.data.id);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      await request(adminApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'RESOLVED' });

      const res = await request(adminApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'RESOLVED' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('COMPLAINT_ALREADY_RESOLVED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 15. Non-admin cannot resolve a complaint (403)
    // ═══════════════════════════════════════════════════════════════════════

    it('15. non-admin cannot resolve a complaint', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Client trying to resolve' });
      tempComplaintIds.push(fileRes.body.data.id);

      const res = await request(clientApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'RESOLVED' });

      expect(res.status).toBe(403);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 16. Non-existent complaint resolution rejected (404)
    // ═══════════════════════════════════════════════════════════════════════

    it('16. non-existent complaint resolution rejected', async () => {
      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .post(`/api/v1/complaints/${randomUUID()}/resolve`)
        .send({ status: 'RESOLVED' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COMPLAINT_NOT_FOUND');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 17. Invalid resolution status rejected (400)
    // ═══════════════════════════════════════════════════════════════════════

    it('17. invalid resolution status rejected', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Invalid status test' });
      tempComplaintIds.push(fileRes.body.data.id);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .post(`/api/v1/complaints/${fileRes.body.data.id}/resolve`)
        .send({ status: 'OPEN' });

      expect(res.status).toBe(400);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 18. Admin can list complaints
    // ═══════════════════════════════════════════════════════════════════════

    it('18. admin can list complaints', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'List test' });
      tempComplaintIds.push(fileRes.body.data.id);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp).get('/api/v1/complaints');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 19. Admin can filter complaints by status
    // ═══════════════════════════════════════════════════════════════════════

    it('19. admin can filter complaints by status', async () => {
      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .get('/api/v1/complaints')
        .query({ status: 'OPEN' });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      // All returned complaints should have status OPEN
      for (const c of res.body.data) {
        expect(c.status).toBe('OPEN');
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 20. Non-admin cannot list complaints (403)
    // ═══════════════════════════════════════════════════════════════════════

    it('20. non-admin cannot list complaints', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app).get('/api/v1/complaints');

      expect(res.status).toBe(403);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 21. Any authenticated user can get a complaint by ID
    // ═══════════════════════════════════════════════════════════════════════

    it('21. any authenticated user can get a complaint by ID', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const fileRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Get by ID test' });
      tempComplaintIds.push(fileRes.body.data.id);

      const res = await request(clientApp).get(
        `/api/v1/complaints/${fileRes.body.data.id}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(fileRes.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 22. Non-existent complaint lookup rejected (404)
    // ═══════════════════════════════════════════════════════════════════════

    it('22. non-existent complaint lookup rejected', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app).get(`/api/v1/complaints/${randomUUID()}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('COMPLAINT_NOT_FOUND');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 23. POST /bookings/:id/reviews creates a CLIENT_TO_WORKER review (path-based)
    // ═══════════════════════════════════════════════════════════════════════

    it('23. path-based POST /bookings/:id/reviews creates a client review', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/reviews`)
        .send({ rating: 5 });

      expect(res.status).toBe(201);
      expect(res.body.data.direction).toBe('CLIENT_TO_WORKER');
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 24. POST /bookings/:id/reviews/worker creates a WORKER_TO_CLIENT review (path-based)
    // ═══════════════════════════════════════════════════════════════════════

    it('24. path-based POST /bookings/:id/reviews/worker creates a worker review', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/reviews/worker`)
        .send({ rating: 4 });

      expect(res.status).toBe(201);
      expect(res.body.data.direction).toBe('WORKER_TO_CLIENT');
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 25. Worker rating is recalculated after a client review
    // ═══════════════════════════════════════════════════════════════════════

    it('25. worker rating is recalculated after a client review', async () => {
      const { clientUserId, workerId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      // Before review, rating should be 0 and count 0
      const before = await prisma.workerProfile.findUnique({
        where: { id: workerId },
        select: { rating: true, ratingCount: true },
      });
      expect(Number(before?.rating)).toBe(0);
      expect(before?.ratingCount).toBe(0);

      // Create a 5-star review
      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/reviews`)
        .send({ rating: 5 });
      tempReviewIds.push(res.body.data.id);

      expect(res.status).toBe(201);

      // After review, rating should be 5 and count 1
      const after = await prisma.workerProfile.findUnique({
        where: { id: workerId },
        select: { rating: true, ratingCount: true },
      });
      expect(Number(after?.rating)).toBe(5);
      expect(after?.ratingCount).toBe(1);
    });
  },
);
