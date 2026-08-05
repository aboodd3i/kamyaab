/**
 * Week 6 — Audit Log Integration Tests
 *
 * Tests the audit log system:
 *   1.  Audit log created on booking completion (BOOKING_COMPLETED)
 *   2.  Audit log created on client-to-worker review (REVIEW_CREATED)
 *   3.  Audit log created on worker-to-client review (REVIEW_CREATED)
 *   4.  Audit log created on complaint filed (COMPLAINT_FILED)
 *   5.  Audit log created on complaint resolved (COMPLAINT_RESOLVED)
 *   6.  Audit log created on worker status change (WORKER_STATUS_CHANGED)
 *   7.  Admin can list audit logs
 *   8.  Admin can filter audit logs by action
 *   9.  Admin can get a single audit log by ID
 *   10. Non-admin cannot list audit logs (403)
 *   11. Non-admin cannot get a single audit log (403)
 *   12. Non-existent audit log ID returns 404
 *   13. Audit log contains correct actorUserId
 *   14. Audit log contains correct bookingId
 *   15. Audit log metadata is preserved
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
import auditLogRoutes from '../routes/auditLogs';
import complaintRoutes from '../routes/complaints';
import reviewRoutes from '../routes/reviews';
import bookingRoutes from '../routes/bookings';
import jobRequestRoutes from '../routes/jobRequests';
import invitationRoutes from '../routes/invitations';
import workerRoutes from '../routes/workers';
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
const tempReviewIds: string[] = [];
const tempAuditLogIds: string[] = [];

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
  app.use('/api/v1/workers', workerRoutes);
  app.use('/api/v1/audit-logs', auditLogRoutes);
  app.use(errorMiddleware);
  return app;
}

/**
 * Wait for audit log to appear (fire-and-forget logAction may have a tiny delay).
 * Polls up to 2 seconds.
 */
async function waitForAuditLog(
  action: string,
  bookingId?: string,
): Promise<{ id: string; action: string; actorUserId: string; bookingId: string | null; metadata: unknown }> {
  for (let i = 0; i < 20; i++) {
    const log = await prisma.auditLog.findFirst({
      where: {
        action: action as never,
        ...(bookingId ? { bookingId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, action: true, actorUserId: true, bookingId: true, metadata: true },
    });
    if (log) {
      tempAuditLogIds.push(log.id);
      return log;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Audit log with action ${action} not found within 2s`);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 6 — Audit Logs',
  () => {
    beforeAll(async () => {
      await rawClient.connect();
    });

    afterAll(async () => {
      // Clean up in reverse dependency order
      if (tempAuditLogIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "AuditLog" WHERE "id" = ANY($1::text[])`,
          [tempAuditLogIds],
        );
      }
      // Also clean up any audit logs for our bookings/workers/users
      if (tempBookingIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "AuditLog" WHERE "bookingId" = ANY($1::text[])`,
          [tempBookingIds],
        );
      }
      if (tempWorkerIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "AuditLog" WHERE "workerId" = ANY($1::text[])`,
          [tempWorkerIds],
        );
      }
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
    // 1. Audit log created on booking completion
    // ═══════════════════════════════════════════════════════════════════════

    it('1. audit log created on booking completion (BOOKING_COMPLETED)', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();

      const log = await waitForAuditLog('BOOKING_COMPLETED', bookingId);
      expect(log.action).toBe('BOOKING_COMPLETED');
      expect(log.actorUserId).toBe(clientUserId);
      expect(log.bookingId).toBe(bookingId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. Audit log created on client-to-worker review
    // ═══════════════════════════════════════════════════════════════════════

    it('2. audit log created on client-to-worker review (REVIEW_CREATED)', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/reviews`)
        .send({ rating: 5, comment: 'Excellent work' });
      expect(res.status).toBe(201);
      tempReviewIds.push(res.body.data.id);

      const log = await waitForAuditLog('REVIEW_CREATED', bookingId);
      expect(log.action).toBe('REVIEW_CREATED');
      expect(log.actorUserId).toBe(clientUserId);
      expect(log.bookingId).toBe(bookingId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. Audit log created on worker-to-client review
    // ═══════════════════════════════════════════════════════════════════════

    it('3. audit log created on worker-to-client review (REVIEW_CREATED)', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/reviews/worker`)
        .send({ rating: 4, comment: 'Good client' });
      expect(res.status).toBe(201);
      tempReviewIds.push(res.body.data.id);

      const log = await waitForAuditLog('REVIEW_CREATED', bookingId);
      expect(log.action).toBe('REVIEW_CREATED');
      expect(log.actorUserId).toBe(workerUserId);
      expect(log.bookingId).toBe(bookingId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4. Audit log created on complaint filed
    // ═══════════════════════════════════════════════════════════════════════

    it('4. audit log created on complaint filed (COMPLAINT_FILED)', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Worker did not show up' });
      expect(res.status).toBe(201);
      tempComplaintIds.push(res.body.data.id);

      const log = await waitForAuditLog('COMPLAINT_FILED', bookingId);
      expect(log.action).toBe('COMPLAINT_FILED');
      expect(log.actorUserId).toBe(clientUserId);
      expect(log.bookingId).toBe(bookingId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 5. Audit log created on complaint resolved
    // ═══════════════════════════════════════════════════════════════════════

    it('5. audit log created on complaint resolved (COMPLAINT_RESOLVED)', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const complaintRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({ bookingId, reason: 'Poor quality work' });
      expect(complaintRes.status).toBe(201);
      const complaintId = complaintRes.body.data.id;
      tempComplaintIds.push(complaintId);

      // Create admin and resolve
      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const resolveRes = await request(adminApp)
        .post(`/api/v1/complaints/${complaintId}/resolve`)
        .send({ status: 'RESOLVED', resolution: 'Worker refunded client' });
      expect(resolveRes.status).toBe(200);

      // Wait for COMPLAINT_RESOLVED audit log
      for (let i = 0; i < 20; i++) {
        const log = await prisma.auditLog.findFirst({
          where: { action: 'COMPLAINT_RESOLVED' as never, complaintId },
          select: { id: true, action: true, actorUserId: true, complaintId: true },
        });
        if (log) {
          tempAuditLogIds.push(log.id);
          expect(log.action).toBe('COMPLAINT_RESOLVED');
          expect(log.actorUserId).toBe(adminUserId);
          expect(log.complaintId).toBe(complaintId);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('COMPLAINT_RESOLVED audit log not found within 2s');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 6. Audit log created on worker status change
    // ═══════════════════════════════════════════════════════════════════════

    it('6. audit log created on worker status change (WORKER_STATUS_CHANGED)', async () => {
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('CLIENT');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .patch(`/api/v1/workers/${workerId}/verify`)
        .send({ status: 'SUSPENDED', reason: 'Policy violation' });
      expect(res.status).toBe(200);

      // Wait for WORKER_STATUS_CHANGED audit log
      for (let i = 0; i < 20; i++) {
        const log = await prisma.auditLog.findFirst({
          where: { action: 'WORKER_STATUS_CHANGED' as never, workerId },
          select: { id: true, action: true, actorUserId: true, workerId: true, metadata: true },
        });
        if (log) {
          tempAuditLogIds.push(log.id);
          expect(log.action).toBe('WORKER_STATUS_CHANGED');
          expect(log.actorUserId).toBe(adminUserId);
          expect(log.workerId).toBe(workerId);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('WORKER_STATUS_CHANGED audit log not found within 2s');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 7. Admin can list audit logs
    // ═══════════════════════════════════════════════════════════════════════

    it('7. admin can list audit logs', async () => {
      // First generate an audit log
      await createCompletedBooking();

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp).get('/api/v1/audit-logs');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 8. Admin can filter audit logs by action
    // ═══════════════════════════════════════════════════════════════════════

    it('8. admin can filter audit logs by action', async () => {
      // Generate a BOOKING_COMPLETED log
      await createCompletedBooking();

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp)
        .get('/api/v1/audit-logs?action=BOOKING_COMPLETED');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // All returned logs should have action BOOKING_COMPLETED
      for (const log of res.body.data) {
        expect(log.action).toBe('BOOKING_COMPLETED');
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 9. Admin can get a single audit log by ID
    // ═══════════════════════════════════════════════════════════════════════

    it('9. admin can get a single audit log by ID', async () => {
      const { bookingId } = await createCompletedBooking();
      const log = await waitForAuditLog('BOOKING_COMPLETED', bookingId);

      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp).get(`/api/v1/audit-logs/${log.id}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(log.id);
      expect(res.body.data.action).toBe('BOOKING_COMPLETED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 10. Non-admin cannot list audit logs (403)
    // ═══════════════════════════════════════════════════════════════════════

    it('10. non-admin cannot list audit logs (403)', async () => {
      const clientUserId = await createTempUser('CLIENT');
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(clientApp).get('/api/v1/audit-logs');

      expect(res.status).toBe(403);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 11. Non-admin cannot get a single audit log (403)
    // ═══════════════════════════════════════════════════════════════════════

    it('11. non-admin cannot get a single audit log (403)', async () => {
      const clientUserId = await createTempUser('CLIENT');
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(clientApp).get('/api/v1/audit-logs/some-id');

      expect(res.status).toBe(403);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 12. Non-existent audit log ID returns 404
    // ═══════════════════════════════════════════════════════════════════════

    it('12. non-existent audit log ID returns 404', async () => {
      const adminUserId = await createTempUser('ADMIN');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(adminApp).get(`/api/v1/audit-logs/${randomUUID()}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUDIT_LOG_NOT_FOUND');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 13. Audit log contains correct actorUserId
    // ═══════════════════════════════════════════════════════════════════════

    it('13. audit log contains correct actorUserId', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const log = await waitForAuditLog('BOOKING_COMPLETED', bookingId);
      expect(log.actorUserId).toBe(clientUserId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 14. Audit log contains correct bookingId
    // ═══════════════════════════════════════════════════════════════════════

    it('14. audit log contains correct bookingId', async () => {
      const { bookingId } = await createCompletedBooking();
      const log = await waitForAuditLog('BOOKING_COMPLETED', bookingId);
      expect(log.bookingId).toBe(bookingId);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 15. Audit log metadata is preserved
    // ═══════════════════════════════════════════════════════════════════════

    it('15. audit log metadata is preserved', async () => {
      const { bookingId } = await createCompletedBooking();
      const log = await waitForAuditLog('BOOKING_COMPLETED', bookingId);
      expect(log.metadata).toBeDefined();
      const metadata = log.metadata as Record<string, unknown>;
      expect(metadata.previousStatus).toBe('CONFIRMED');
      expect(metadata.newStatus).toBe('COMPLETED');
    });
  },
);
