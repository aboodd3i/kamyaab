/**
 * Week 7 — End-to-End Marketplace Journey Integration Tests
 *
 * Two full lifecycle journeys exercised against a real PostgreSQL database
 * with mocked auth middleware:
 *
 *   Journey A — SPECIFIC_WORKER flow:
 *     agent creates worker → admin approves → client searches workers →
 *     client creates job request → client submits → worker accepts →
 *     client completes booking → client reviews worker → worker reviews client →
 *     client files complaint → admin resolves complaint → verify audit logs
 *
 *   Journey B — OPEN job matching flow:
 *     agent creates 2 workers → admin approves both →
 *     client creates OPEN job → system matches → batch invitations →
 *     first worker accepts → booking created → other invitation expired →
 *     client completes booking
 *
 * Uses a real PostgreSQL database with mocked auth middleware.
 * Gated by RUN_DB_INTEGRATION_TESTS=true.
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
import workerRoutes from '../routes/workers';
import publicWorkerRoutes from '../routes/publicWorkers';
import jobRequestRoutes from '../routes/jobRequests';
import invitationRoutes from '../routes/invitations';
import bookingRoutes from '../routes/bookings';
import reviewRoutes from '../routes/reviews';
import complaintRoutes from '../routes/complaints';
import auditLogRoutes from '../routes/auditLogs';
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

  // Public worker discovery (no auth) — but our mock sets req.user anyway
  app.use('/api/v1/workers', publicWorkerRoutes);
  app.use('/api/v1/workers', workerRoutes);
  app.use('/api/v1/job-requests', jobRequestRoutes);
  app.use('/api/v1/invitations', invitationRoutes);
  app.use('/api/v1/bookings', bookingRoutes);
  app.use('/api/v1/reviews', reviewRoutes);
  app.use('/api/v1/complaints', complaintRoutes);
  app.use('/api/v1/audit-logs', auditLogRoutes);
  app.use(errorMiddleware);
  return app;
}

/**
 * Wait for audit log to appear (fire-and-forget logAction may have a tiny delay).
 * Polls up to 3 seconds.
 */
async function waitForAuditLog(
  action: string,
  bookingId?: string,
): Promise<{ id: string; action: string; actorUserId: string; bookingId: string | null; metadata: unknown }> {
  for (let i = 0; i < 30; i++) {
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
  throw new Error(`Audit log with action ${action} not found within 3s`);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 7 — End-to-End Marketplace Journeys',
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
    // Journey A — SPECIFIC_WORKER full lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    it('Journey A: SPECIFIC_WORKER full lifecycle (create → approve → search → job → accept → complete → review → complain → resolve)', async () => {
      // ── 1. Create users ─────────────────────────────────────────────────
      const agentUserId = await createTempUser('AGENT');
      const adminUserId = await createTempUser('ADMIN');
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const workerUserId = await createTempUser('WORKER');

      const categoryId = await createTempCategory();
      const areaId = await createTempArea();

      // ── 2. Agent creates worker profile ─────────────────────────────────
      const agentApp = createAppWithUser(agentUserId, 'AGENT');
      const createRes = await request(agentApp)
        .post('/api/v1/workers')
        .send({
          name: `${PREFIX}-worker-A`,
          phone: '03001234567',
          cnicNumber: `${PREFIX}-cnic-A`,
          referenceName: `${PREFIX}-ref-A`,
          referencePhone: '03007654321',
          identityChecked: true,
          phoneConfirmed: true,
          backgroundChecked: true,
          skillAssessed: true,
          categoryIds: [categoryId],
          serviceAreaIds: [areaId],
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.success).toBe(true);
      const workerId = createRes.body.data.id;
      tempWorkerIds.push(workerId);

      // Worker starts as PENDING_APPROVAL
      expect(createRes.body.data.status).toBe('PENDING_APPROVAL');

      // ── 3. Admin approves the worker ────────────────────────────────────
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');
      const verifyRes = await request(adminApp)
        .patch(`/api/v1/workers/${workerId}/verify`)
        .send({ status: 'APPROVED' });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.status).toBe('APPROVED');

      // Link the worker profile to the worker user so the worker can act
      // on invitations (the invitation route resolves worker by userId)
      await prisma.workerProfile.update({
        where: { id: workerId },
        data: { userId: workerUserId },
      });

      // ── 4. Client searches for workers ──────────────────────────────────
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const searchRes = await request(clientApp)
        .get('/api/v1/workers')
        .query({ categoryId, areaId });

      expect(searchRes.status).toBe(200);
      expect(searchRes.body.success).toBe(true);
      // Our worker should appear in search results (public DTO doesn't include status)
      const workersList = searchRes.body.data.data as Array<{ id: string; name: string }>;
      const foundWorker = workersList.find((w) => w.id === workerId);
      expect(foundWorker).toBeDefined();
      expect(foundWorker!.name).toBe(`${PREFIX}-worker-A`);

      // ── 5. Client creates a SPECIFIC_WORKER job request ─────────────────
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: `${PREFIX} — Journey A: need urgent plumbing repair`,
          urgency: 'URGENT',
          budget: 5000,
          type: 'SPECIFIC_WORKER',
        });

      expect(draftRes.status).toBe(201);
      const jobRequestId = draftRes.body.data.id;
      tempJobRequestIds.push(jobRequestId);
      expect(draftRes.body.data.status).toBe('DRAFT');

      // ── 6. Client submits the job request targeting the specific worker ─
      const submitRes = await request(clientApp)
        .post(`/api/v1/job-requests/${jobRequestId}/submit`)
        .send({ targetWorkerId: workerId });

      expect(submitRes.status).toBe(200);
      expect(submitRes.body.data.status).toBe('WORKER_CONTACTED');

      // Fetch the invitation
      const invitation = await prisma.jobInvitation.findFirst({
        where: { jobRequestId },
        select: { id: true, status: true },
      });
      expect(invitation).toBeDefined();
      expect(invitation!.status).toBe('PENDING');
      tempInvitationIds.push(invitation!.id);

      // ── 7. Worker accepts the invitation ────────────────────────────────
      const workerApp = createAppWithUser(workerUserId, 'WORKER');
      const acceptRes = await request(workerApp)
        .post(`/api/v1/invitations/${invitation!.id}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.data.booking).toBeDefined();
      const bookingId = acceptRes.body.data.booking.id;
      tempBookingIds.push(bookingId);

      // Verify job request moved to ACCEPTED
      const jobAfterAccept = await prisma.jobRequest.findUnique({
        where: { id: jobRequestId },
        select: { status: true },
      });
      expect(jobAfterAccept!.status).toBe('ACCEPTED');

      // ── 8. Client completes the booking ─────────────────────────────────
      const completeRes = await request(clientApp)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.data.status).toBe('COMPLETED');

      // ── 9. Client reviews the worker ────────────────────────────────────
      const clientReviewRes = await request(clientApp)
        .post(`/api/v1/bookings/${bookingId}/reviews`)
        .send({ rating: 5, comment: 'Excellent work, very professional!' });

      expect(clientReviewRes.status).toBe(201);
      expect(clientReviewRes.body.data.rating).toBe(5);
      tempReviewIds.push(clientReviewRes.body.data.id);

      // ── 10. Worker reviews the client ───────────────────────────────────
      const workerReviewRes = await request(workerApp)
        .post(`/api/v1/bookings/${bookingId}/reviews/worker`)
        .send({ rating: 4, comment: 'Good client, clear requirements.' });

      expect(workerReviewRes.status).toBe(201);
      expect(workerReviewRes.body.data.rating).toBe(4);
      tempReviewIds.push(workerReviewRes.body.data.id);

      // ── 11. Client files a complaint ────────────────────────────────────
      const complaintRes = await request(clientApp)
        .post('/api/v1/complaints')
        .send({
          bookingId,
          reason: `${PREFIX} — Worker arrived late and left the job incomplete`,
        });

      expect(complaintRes.status).toBe(201);
      expect(complaintRes.body.data.id).toBeDefined();
      const complaintId = complaintRes.body.data.id;
      tempComplaintIds.push(complaintId);

      // ── 12. Admin resolves the complaint ────────────────────────────────
      const resolveRes = await request(adminApp)
        .post(`/api/v1/complaints/${complaintId}/resolve`)
        .send({ status: 'RESOLVED', resolution: 'Contacted worker, issue resolved with partial refund.' });

      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.data.status).toBe('RESOLVED');

      // ── 13. Verify audit logs were created ──────────────────────────────
      // Booking completion should have an audit log
      const bookingLog = await waitForAuditLog('BOOKING_COMPLETED', bookingId);
      expect(bookingLog.action).toBe('BOOKING_COMPLETED');

      // Complaint filed should have an audit log
      const complaintFiledLog = await waitForAuditLog('COMPLAINT_FILED', bookingId);
      expect(complaintFiledLog.action).toBe('COMPLAINT_FILED');

      // Complaint resolved should have an audit log
      const complaintResolvedLog = await waitForAuditLog('COMPLAINT_RESOLVED', bookingId);
      expect(complaintResolvedLog.action).toBe('COMPLAINT_RESOLVED');

      // ── 14. Admin can list audit logs ───────────────────────────────────
      const auditListRes = await request(adminApp)
        .get('/api/v1/audit-logs')
        .query({ limit: 50 });

      expect(auditListRes.status).toBe(200);
      expect(auditListRes.body.success).toBe(true);
      expect(Array.isArray(auditListRes.body.data)).toBe(true);
      // At least 3 audit logs from our journey
      expect(auditListRes.body.data.length).toBeGreaterThanOrEqual(3);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Journey B — OPEN job matching flow
    // ═══════════════════════════════════════════════════════════════════════

    it('Journey B: OPEN job matching flow (create workers → OPEN job → match → batch invite → first-accept-wins → complete)', async () => {
      // ── 1. Create users ─────────────────────────────────────────────────
      const agentUserId = await createTempUser('AGENT');
      const adminUserId = await createTempUser('ADMIN');
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);

      const categoryId = await createTempCategory();
      const areaId = await createTempArea();

      // ── 2. Create two workers in the same category+area ─────────────────
      const agentApp = createAppWithUser(agentUserId, 'AGENT');
      const adminApp = createAppWithUser(adminUserId, 'ADMIN');

      const worker1Create = await request(agentApp)
        .post('/api/v1/workers')
        .send({
          name: `${PREFIX}-worker-B1`,
          phone: '03011111111',
          cnicNumber: `${PREFIX}-cnic-B1`,
          referenceName: `${PREFIX}-ref-B1`,
          referencePhone: '03012222222',
          identityChecked: true,
          phoneConfirmed: true,
          backgroundChecked: true,
          skillAssessed: true,
          categoryIds: [categoryId],
          serviceAreaIds: [areaId],
        });
      expect(worker1Create.status).toBe(201);
      const worker1Id = worker1Create.body.data.id;
      tempWorkerIds.push(worker1Id);

      const worker2Create = await request(agentApp)
        .post('/api/v1/workers')
        .send({
          name: `${PREFIX}-worker-B2`,
          phone: '03013333333',
          cnicNumber: `${PREFIX}-cnic-B2`,
          referenceName: `${PREFIX}-ref-B2`,
          referencePhone: '03014444444',
          identityChecked: true,
          phoneConfirmed: true,
          backgroundChecked: true,
          skillAssessed: true,
          categoryIds: [categoryId],
          serviceAreaIds: [areaId],
        });
      expect(worker2Create.status).toBe(201);
      const worker2Id = worker2Create.body.data.id;
      tempWorkerIds.push(worker2Id);

      // ── 3. Admin approves both workers ──────────────────────────────────
      const verify1 = await request(adminApp)
        .patch(`/api/v1/workers/${worker1Id}/verify`)
        .send({ status: 'APPROVED' });
      expect(verify1.status).toBe(200);

      const verify2 = await request(adminApp)
        .patch(`/api/v1/workers/${worker2Id}/verify`)
        .send({ status: 'APPROVED' });
      expect(verify2.status).toBe(200);

      // ── 4. Client creates an OPEN job request ───────────────────────────
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({
          categoryId,
          areaId,
          description: `${PREFIX} — Journey B: need an electrician urgently`,
          urgency: 'URGENT',
          budget: 3000,
          type: 'OPEN',
        });

      expect(draftRes.status).toBe(201);
      const jobRequestId = draftRes.body.data.id;
      tempJobRequestIds.push(jobRequestId);
      expect(draftRes.body.data.type).toBe('OPEN');

      // ── 5. Client submits the OPEN job — system matches & batch-invites ─
      const submitRes = await request(clientApp)
        .post(`/api/v1/job-requests/${jobRequestId}/submit`)
        .send({});

      expect(submitRes.status).toBe(200);
      expect(submitRes.body.data.status).toBe('MATCHING');

      // ── 6. Verify batch invitations were created ─────────────────────────
      const invitations = await prisma.jobInvitation.findMany({
        where: { jobRequestId },
        select: { id: true, workerId: true, status: true },
        orderBy: { workerId: 'asc' },
      });

      // Both workers should have been invited
      expect(invitations.length).toBe(2);
      expect(invitations.every((inv) => inv.status === 'PENDING')).toBe(true);
      for (const inv of invitations) {
        tempInvitationIds.push(inv.id);
      }

      // ── 7. First worker accepts — first-accept-wins ─────────────────────
      // Determine which worker is "first" — use worker1
      const worker1UserId = await createTempUser('WORKER');
      // Link worker1 to this user so the invitation route can find it
      await prisma.workerProfile.update({
        where: { id: worker1Id },
        data: { userId: worker1UserId },
      });

      const worker1App = createAppWithUser(worker1UserId, 'WORKER');
      const invitation1 = invitations.find((inv) => inv.workerId === worker1Id)!;
      const accept1Res = await request(worker1App)
        .post(`/api/v1/invitations/${invitation1.id}/respond`)
        .send({ status: 'ACCEPTED' });

      expect(accept1Res.status).toBe(200);
      expect(accept1Res.body.data.booking).toBeDefined();
      const bookingId = accept1Res.body.data.booking.id;
      tempBookingIds.push(bookingId);

      // ── 8. Verify the other invitation was expired (first-accept-wins) ───
      const invitation2After = await prisma.jobInvitation.findUnique({
        where: { id: invitations.find((inv) => inv.workerId === worker2Id)!.id },
        select: { status: true },
      });
      expect(invitation2After!.status).toBe('EXPIRED');

      // ── 9. Verify job request moved to ACCEPTED ─────────────────────────
      const jobAfterAccept = await prisma.jobRequest.findUnique({
        where: { id: jobRequestId },
        select: { status: true },
      });
      expect(jobAfterAccept!.status).toBe('ACCEPTED');

      // ── 10. Client completes the booking ────────────────────────────────
      const completeRes = await request(clientApp)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.data.status).toBe('COMPLETED');

      // ── 11. Verify booking completion audit log ─────────────────────────
      const bookingLog = await waitForAuditLog('BOOKING_COMPLETED', bookingId);
      expect(bookingLog.action).toBe('BOOKING_COMPLETED');
    });
  },
);
