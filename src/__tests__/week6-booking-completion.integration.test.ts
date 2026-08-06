/**
 * Week 6 — Booking Completion Integration Tests
 *
 * Tests the POST /api/v1/bookings/:id/complete endpoint:
 *   - owning CLIENT can complete a CONFIRMED booking
 *   - status transitions to COMPLETED, completedAt is set, confirmedAt preserved
 *   - safe DTO (no contact phones, CNIC, paths, etc.)
 *   - idempotent re-completion
 *   - concurrent completion safety
 *   - role authorization (only CLIENT)
 *   - ownership enforcement (another client gets 404)
 *   - invalid transitions (CANCELLED cannot be completed)
 *   - nonexistent booking returns 404
 *   - no side effects on unrelated records
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
import bookingRoutes from '../routes/bookings';
import jobRequestRoutes from '../routes/jobRequests';
import invitationRoutes from '../routes/invitations';
import { errorMiddleware } from '../lib/errors';
import { findForbiddenBookingKey } from '../lib/bookingDto';

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
 * Create a full booking flow: client creates draft → submits → worker accepts.
 * Returns the booking ID and all related entity IDs.
 */
async function createConfirmedBooking(): Promise<{
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
  app.use(errorMiddleware);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 6 — Booking Completion',
  () => {
    beforeAll(async () => {
      await rawClient.connect();
    });

    afterAll(async () => {
      // Clean up AuditLog records first (Week 6 audit logging creates these
      // with FK references to User, Booking, etc.)
      if (tempUserIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "AuditLog" WHERE "actorUserId" = ANY($1::text[])`,
          [tempUserIds],
        );
      }
      if (tempBookingIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "AuditLog" WHERE "bookingId" = ANY($1::text[])`,
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
    // 1. Owning client can complete a CONFIRMED booking
    // ═══════════════════════════════════════════════════════════════════════

    it('1. the owning authenticated CLIENT can complete a CONFIRMED booking', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('COMPLETED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. Completion changes status to COMPLETED
    // ═══════════════════════════════════════════════════════════════════════

    it('2. completion changes the database status to COMPLETED', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      await request(app).post(`/api/v1/bookings/${bookingId}/complete`).send();

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      });
      expect(booking?.status).toBe('COMPLETED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. completedAt is populated
    // ═══════════════════════════════════════════════════════════════════════

    it('3. completedAt is populated after completion', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.body.data.completedAt).not.toBeNull();
      const completedAt = new Date(res.body.data.completedAt);
      expect(completedAt.getTime()).not.toBeNaN();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4. confirmedAt remains unchanged
    // ═══════════════════════════════════════════════════════════════════════

    it('4. confirmedAt remains unchanged after completion', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();

      const before = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { confirmedAt: true },
      });

      const app = createAppWithUser(clientUserId, 'CLIENT');
      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.body.data.confirmedAt).toBe(before!.confirmedAt.toISOString());
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 5. Database row contains expected status and timestamp
    // ═══════════════════════════════════════════════════════════════════════

    it('5. the database row contains the expected status and completedAt timestamp', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { status: true, completedAt: true, confirmedAt: true },
      });

      expect(booking?.status).toBe('COMPLETED');
      expect(booking?.completedAt).not.toBeNull();
      expect(booking?.completedAt!.toISOString()).toBe(res.body.data.completedAt);
      expect(booking?.confirmedAt.toISOString()).toBe(res.body.data.confirmedAt);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 6 & 7. Response uses safe DTO — no forbidden fields
    // ═══════════════════════════════════════════════════════════════════════

    it('6-7. the response uses the safe DTO with no contact phones, CNIC, paths, or nested objects', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.status).toBe(200);

      // Check allowlisted fields are present
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.jobRequestId).toBeDefined();
      expect(res.body.data.workerId).toBeDefined();
      expect(res.body.data.status).toBeDefined();
      expect(res.body.data.confirmedAt).toBeDefined();
      expect(res.body.data.completedAt).toBeDefined();
      expect(res.body.data.createdAt).toBeDefined();
      expect(res.body.data.updatedAt).toBeDefined();

      // Scan for forbidden keys
      const forbidden = findForbiddenBookingKey(res.body.data);
      expect(forbidden).toBeNull();

      // Explicitly check no contact phones
      expect(res.body.data).not.toHaveProperty('clientPhone');
      expect(res.body.data).not.toHaveProperty('workerPhone');

      // No nested objects (raw Prisma relations)
      const data = res.body.data;
      expect(data).not.toHaveProperty('jobRequest');
      expect(data).not.toHaveProperty('worker');
      expect(data).not.toHaveProperty('invitation');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 8-10. Idempotent re-completion
    // ═══════════════════════════════════════════════════════════════════════

    it('8-10. repeating completion returns HTTP 200 with the same booking ID and original completedAt', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res1 = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();
      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();
      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(res2.body.data.status).toBe('COMPLETED');

      // Same booking ID
      expect(res2.body.data.id).toBe(res1.body.data.id);

      // Original completedAt preserved
      expect(res2.body.data.completedAt).toBe(res1.body.data.completedAt);

      // No extra writes — verify only one booking row exists
      const bookings = await prisma.booking.findMany({
        where: { jobRequestId: res1.body.data.jobRequestId },
      });
      expect(bookings).toHaveLength(1);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 11-12. Concurrent completion safety
    // ═══════════════════════════════════════════════════════════════════════

    it('11-12. two concurrent completion requests both resolve safely with one completed state', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const [res1, res2] = await Promise.all([
        request(app).post(`/api/v1/bookings/${bookingId}/complete`).send(),
        request(app).post(`/api/v1/bookings/${bookingId}/complete`).send(),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.data.status).toBe('COMPLETED');
      expect(res2.body.data.status).toBe('COMPLETED');

      // Same booking ID
      expect(res1.body.data.id).toBe(res2.body.data.id);

      // Same completedAt (no overwrite)
      expect(res1.body.data.completedAt).toBe(res2.body.data.completedAt);

      // Database has exactly one COMPLETED booking
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { status: true, completedAt: true },
      });
      expect(booking?.status).toBe('COMPLETED');
      expect(booking?.completedAt).not.toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 13. Another client cannot complete the booking
    // ═══════════════════════════════════════════════════════════════════════

    it('13. another CLIENT cannot complete the booking', async () => {
      const { bookingId } = await createConfirmedBooking();

      // Different client
      const otherClientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(otherClientUserId);
      const app = createAppWithUser(otherClientUserId, 'CLIENT');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 14. A WORKER cannot complete the booking
    // ═══════════════════════════════════════════════════════════════════════

    it('14. a WORKER cannot complete the booking', async () => {
      const { workerUserId, bookingId } = await createConfirmedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 15. An AGENT cannot complete the booking
    // ═══════════════════════════════════════════════════════════════════════

    it('15. an AGENT cannot complete the booking', async () => {
      const { bookingId } = await createConfirmedBooking();

      const agentUserId = await createTempUser('AGENT');
      const app = createAppWithUser(agentUserId, 'AGENT');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 16. An ADMIN cannot complete the booking
    // ═══════════════════════════════════════════════════════════════════════

    it('16. an ADMIN cannot complete the booking', async () => {
      const { bookingId } = await createConfirmedBooking();

      const adminUserId = await createTempUser('ADMIN');
      const app = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 17. Unauthenticated caller is rejected
    // ═══════════════════════════════════════════════════════════════════════

    it('17. an unauthenticated caller is rejected', async () => {
      const { bookingId } = await createConfirmedBooking();

      // App without auth middleware injection
      const app = express();
      app.use(express.json());
      // No req.user injection — authenticate mock is a no-op but requireRole
      // will fail because req.user is undefined
      app.use('/api/v1/bookings', bookingRoutes);
      app.use(errorMiddleware);

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 18. A CANCELLED booking cannot be completed
    // ═══════════════════════════════════════════════════════════════════════

    it('18. a CANCELLED booking cannot be completed', async () => {
      const { clientUserId, bookingId } = await createConfirmedBooking();

      // Directly set the booking to CANCELLED
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
        },
      });

      const app = createAppWithUser(clientUserId, 'CLIENT');
      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/complete`)
        .send();

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 19. Nonexistent booking returns safe not-found
    // ═══════════════════════════════════════════════════════════════════════

    it('19. a nonexistent booking returns the safe not-found response', async () => {
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post(`/api/v1/bookings/nonexistent-booking-id/complete`)
        .send();

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 20. Completing one booking does not modify unrelated records
    // ═══════════════════════════════════════════════════════════════════════

    it('20. completing one booking does not modify unrelated bookings, JobRequests, or invitations', async () => {
      const bookingA = await createConfirmedBooking();
      const bookingB = await createConfirmedBooking();

      // Capture state of booking B before completing A
      const bookingBBefore = await prisma.booking.findUnique({
        where: { id: bookingB.bookingId },
        select: { status: true, completedAt: true, confirmedAt: true, updatedAt: true },
      });

      const jobRequestBBefore = await prisma.jobRequest.findUnique({
        where: { id: bookingB.jobRequestId },
        select: { status: true, updatedAt: true },
      });

      const invitationBBefore = await prisma.jobInvitation.findUnique({
        where: { id: bookingB.invitationId },
        select: { status: true, updatedAt: true },
      });

      // Complete booking A
      const appA = createAppWithUser(bookingA.clientUserId, 'CLIENT');
      const res = await request(appA)
        .post(`/api/v1/bookings/${bookingA.bookingId}/complete`)
        .send();
      expect(res.status).toBe(200);

      // Verify booking B is unchanged
      const bookingBAfter = await prisma.booking.findUnique({
        where: { id: bookingB.bookingId },
        select: { status: true, completedAt: true, confirmedAt: true },
      });
      expect(bookingBAfter?.status).toBe(bookingBBefore?.status);
      expect(bookingBAfter?.completedAt).toEqual(bookingBBefore?.completedAt);
      expect(bookingBAfter?.confirmedAt).toEqual(bookingBBefore?.confirmedAt);

      // Verify job request B is unchanged
      const jobRequestBAfter = await prisma.jobRequest.findUnique({
        where: { id: bookingB.jobRequestId },
        select: { status: true },
      });
      expect(jobRequestBAfter?.status).toBe(jobRequestBBefore?.status);

      // Verify invitation B is unchanged
      const invitationBAfter = await prisma.jobInvitation.findUnique({
        where: { id: bookingB.invitationId },
        select: { status: true },
      });
      expect(invitationBAfter?.status).toBe(invitationBBefore?.status);
    });
  },
);
