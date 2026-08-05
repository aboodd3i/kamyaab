/**
 * Week 6 — Worker Review Integration Tests
 *
 * Tests the POST /api/v1/reviews/worker endpoint (WORKER → CLIENT review):
 *   1.  WORKER can review a completed booking
 *   2.  Review direction is WORKER_TO_CLIENT
 *   3.  Reviewer is the authenticated worker
 *   4.  Reviewee is the booking client's User
 *   5.  Rating is stored correctly
 *   6.  Comment is stored correctly
 *   7.  Safe DTO returned (no forbidden fields)
 *   8.  Duplicate review rejected (409)
 *   9.  Another worker cannot review the booking (404)
 *   10. Client cannot access endpoint (403)
 *   11. Agent cannot access endpoint (403)
 *   12. Admin cannot access endpoint (403)
 *   13. Unauthenticated caller rejected (403)
 *   14. Booking not completed rejected (400)
 *   15. Non-existent booking rejected (404)
 *   16. Booking owned by another worker rejected (404)
 *   17. Invalid rating rejected (400)
 *   18. Concurrent requests create exactly one review row
 *   19. No sensitive fields appear anywhere in the response
 *   20. Existing CLIENT → WORKER review tests continue passing
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
import reviewRoutes from '../routes/reviews';
import bookingRoutes from '../routes/bookings';
import jobRequestRoutes from '../routes/jobRequests';
import invitationRoutes from '../routes/invitations';
import { errorMiddleware } from '../lib/errors';
import { findForbiddenReviewKey } from '../lib/reviewDto';

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
const tempReviewIds: string[] = [];

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
  const workerUserId = await createTempUser('WORKER');
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
  app.use(errorMiddleware);
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)(
  'Week 6 — Worker Review',
  () => {
    beforeAll(async () => {
      await rawClient.connect();
    });

    afterAll(async () => {
      // Clean up in reverse dependency order
      if (tempReviewIds.length > 0) {
        await rawClient.query(
          `DELETE FROM "Review" WHERE "id" = ANY($1::text[])`,
          [tempReviewIds],
        );
      }
      // Also clean up any reviews for our bookings (in case IDs weren't captured)
      if (tempBookingIds.length > 0) {
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
    // 1. WORKER can review a completed booking
    // ═══════════════════════════════════════════════════════════════════════

    it('1. the assigned WORKER can review a completed booking', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. Review direction is WORKER_TO_CLIENT
    // ═══════════════════════════════════════════════════════════════════════

    it('2. the review direction is WORKER_TO_CLIENT', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 4 });

      expect(res.status).toBe(201);
      expect(res.body.data.direction).toBe('WORKER_TO_CLIENT');
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. Reviewer is the authenticated worker
    // ═══════════════════════════════════════════════════════════════════════

    it('3. the reviewerUserId is the authenticated worker\'s User ID', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 3 });

      expect(res.status).toBe(201);
      expect(res.body.data.reviewerUserId).toBe(workerUserId);
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4. Reviewee is the booking client's User
    // ═══════════════════════════════════════════════════════════════════════

    it('4. the revieweeUserId is the booking client\'s User ID', async () => {
      const { clientUserId, workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });

      expect(res.status).toBe(201);
      expect(res.body.data.revieweeUserId).toBe(clientUserId);
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 5. Rating is stored correctly
    // ═══════════════════════════════════════════════════════════════════════

    it('5. the rating is stored correctly in the database', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 2 });

      expect(res.status).toBe(201);
      expect(res.body.data.rating).toBe(2);

      const review = await prisma.review.findUnique({
        where: { id: res.body.data.id },
        select: { rating: true },
      });
      expect(review?.rating).toBe(2);
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 6. Comment is stored correctly
    // ═══════════════════════════════════════════════════════════════════════

    it('6. the comment is stored correctly and trimmed', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 4, comment: '  Good client!  ' });

      expect(res.status).toBe(201);
      expect(res.body.data.comment).toBe('Good client!');

      const review = await prisma.review.findUnique({
        where: { id: res.body.data.id },
        select: { comment: true },
      });
      expect(review?.comment).toBe('Good client!');
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 7 & 19. Safe DTO returned — no sensitive fields
    // ═══════════════════════════════════════════════════════════════════════

    it('7-19. the response uses the safe DTO with no sensitive fields', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5, comment: 'Excellent client' });

      expect(res.status).toBe(201);

      // Check allowlisted fields are present
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.bookingId).toBeDefined();
      expect(res.body.data.direction).toBeDefined();
      expect(res.body.data.rating).toBeDefined();
      expect(res.body.data.comment).toBeDefined();
      expect(res.body.data.createdAt).toBeDefined();
      expect(res.body.data.updatedAt).toBeDefined();
      expect(res.body.data.reviewerUserId).toBeDefined();
      expect(res.body.data.revieweeUserId).toBeDefined();

      // Scan for forbidden keys
      const forbidden = findForbiddenReviewKey(res.body.data);
      expect(forbidden).toBeNull();

      // Explicitly check no sensitive fields
      expect(res.body.data).not.toHaveProperty('clientPhone');
      expect(res.body.data).not.toHaveProperty('workerPhone');
      expect(res.body.data).not.toHaveProperty('cnicNumber');
      expect(res.body.data).not.toHaveProperty('cnicFrontPath');
      expect(res.body.data).not.toHaveProperty('cnicBackPath');
      expect(res.body.data).not.toHaveProperty('referenceName');
      expect(res.body.data).not.toHaveProperty('referencePhone');

      // No nested Prisma objects
      expect(res.body.data).not.toHaveProperty('booking');
      expect(res.body.data).not.toHaveProperty('reviewer');
      expect(res.body.data).not.toHaveProperty('reviewee');
      tempReviewIds.push(res.body.data.id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 8. Duplicate review rejected
    // ═══════════════════════════════════════════════════════════════════════

    it('8. a duplicate WORKER_TO_CLIENT review is rejected with 409', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res1 = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });
      expect(res1.status).toBe(201);
      tempReviewIds.push(res1.body.data.id);

      const res2 = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 3, comment: 'Trying again' });
      expect(res2.status).toBe(409);
      expect(res2.body.success).toBe(false);

      // Original review is unchanged
      const review = await prisma.review.findUnique({
        where: { id: res1.body.data.id },
        select: { rating: true, comment: true },
      });
      expect(review?.rating).toBe(5);
      expect(review?.comment).toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 9. Another worker cannot review the booking
    // ═══════════════════════════════════════════════════════════════════════

    it('9. another WORKER cannot review a booking they are not assigned to', async () => {
      const { bookingId } = await createCompletedBooking();

      // Create a different worker
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const otherWorkerUserId = await createTempUser('WORKER');
      await createTempClaimedWorker(otherWorkerUserId, categoryId, areaId);
      const app = createAppWithUser(otherWorkerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 10. Client cannot access endpoint
    // ═══════════════════════════════════════════════════════════════════════

    it('10. a CLIENT cannot access the worker review endpoint', async () => {
      const { clientUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(clientUserId, 'CLIENT');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 11. Agent cannot access endpoint
    // ═══════════════════════════════════════════════════════════════════════

    it('11. an AGENT cannot access the worker review endpoint', async () => {
      const { bookingId } = await createCompletedBooking();

      const agentUserId = await createTempUser('AGENT');
      const app = createAppWithUser(agentUserId, 'AGENT');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 12. Admin cannot access endpoint
    // ═══════════════════════════════════════════════════════════════════════

    it('12. an ADMIN cannot access the worker review endpoint', async () => {
      const { bookingId } = await createCompletedBooking();

      const adminUserId = await createTempUser('ADMIN');
      const app = createAppWithUser(adminUserId, 'ADMIN');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 13. Unauthenticated caller rejected
    // ═══════════════════════════════════════════════════════════════════════

    it('13. an unauthenticated caller is rejected', async () => {
      const { bookingId } = await createCompletedBooking();

      // App without auth middleware injection — req.user is undefined
      const app = express();
      app.use(express.json());
      app.use('/api/v1/reviews', reviewRoutes);
      app.use(errorMiddleware);

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 14. Booking not completed rejected
    // ═══════════════════════════════════════════════════════════════════════

    it('14. a CONFIRMED (not completed) booking cannot be reviewed', async () => {
      // Create a booking but don't complete it
      const clientUserId = await createTempUser('CLIENT');
      await createTempClientProfile(clientUserId);
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      const workerId = await createTempClaimedWorker(workerUserId, categoryId, areaId);

      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const draftRes = await request(clientApp)
        .post('/api/v1/job-requests')
        .send({ categoryId, areaId, description: `${PREFIX} — need service` });
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

      // Booking is CONFIRMED, not COMPLETED — try to review
      const res = await request(workerApp)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 5 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 15. Non-existent booking rejected
    // ═══════════════════════════════════════════════════════════════════════

    it('15. a non-existent booking returns 404', async () => {
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const workerUserId = await createTempUser('WORKER');
      await createTempClaimedWorker(workerUserId, categoryId, areaId);
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId: 'nonexistent-booking-id', rating: 5 });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 16. Booking owned by another worker rejected (no leak)
    // ═══════════════════════════════════════════════════════════════════════

    it('16. a booking assigned to another worker is rejected with 404 (no leak)', async () => {
      const { bookingId } = await createCompletedBooking();

      // Create a different worker
      const categoryId = await createTempCategory();
      const areaId = await createTempArea();
      const otherWorkerUserId = await createTempUser('WORKER');
      await createTempClaimedWorker(otherWorkerUserId, categoryId, areaId);
      const app = createAppWithUser(otherWorkerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 4, comment: 'Not my booking' });

      // Generic 404 — does not reveal the booking exists
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 17. Invalid rating rejected
    // ═══════════════════════════════════════════════════════════════════════

    it('17. an invalid rating (0) is rejected', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 0 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('17b. an invalid rating (6) is rejected', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 6 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('17c. a missing rating is rejected', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ bookingId });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('17d. a missing bookingId is rejected', async () => {
      const { workerUserId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const res = await request(app)
        .post('/api/v1/reviews/worker')
        .send({ rating: 5 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 18. Concurrent review creation creates exactly one review row
    // ═══════════════════════════════════════════════════════════════════════

    it('18. two concurrent worker review submissions create exactly one review row', async () => {
      const { workerUserId, bookingId } = await createCompletedBooking();
      const app = createAppWithUser(workerUserId, 'WORKER');

      const [res1, res2] = await Promise.all([
        request(app).post('/api/v1/reviews/worker').send({ bookingId, rating: 5, comment: 'First' }),
        request(app).post('/api/v1/reviews/worker').send({ bookingId, rating: 4, comment: 'Second' }),
      ]);

      // One succeeds (201), the other gets duplicate (409)
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      // Exactly one review row exists
      const reviews = await prisma.review.findMany({
        where: { bookingId, direction: 'WORKER_TO_CLIENT' },
      });
      expect(reviews).toHaveLength(1);
      tempReviewIds.push(reviews[0].id);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 20. Both CLIENT_TO_WORKER and WORKER_TO_CLIENT reviews can coexist
    // ═══════════════════════════════════════════════════════════════════════

    it('20. both CLIENT_TO_WORKER and WORKER_TO_CLIENT reviews can coexist on the same booking', async () => {
      const { clientUserId, workerUserId, bookingId } = await createCompletedBooking();

      // Client reviews worker
      const clientApp = createAppWithUser(clientUserId, 'CLIENT');
      const clientReviewRes = await request(clientApp)
        .post('/api/v1/reviews')
        .send({ bookingId, rating: 5, comment: 'Great worker' });
      expect(clientReviewRes.status).toBe(201);
      expect(clientReviewRes.body.data.direction).toBe('CLIENT_TO_WORKER');
      tempReviewIds.push(clientReviewRes.body.data.id);

      // Worker reviews client
      const workerApp = createAppWithUser(workerUserId, 'WORKER');
      const workerReviewRes = await request(workerApp)
        .post('/api/v1/reviews/worker')
        .send({ bookingId, rating: 4, comment: 'Good client' });
      expect(workerReviewRes.status).toBe(201);
      expect(workerReviewRes.body.data.direction).toBe('WORKER_TO_CLIENT');
      tempReviewIds.push(workerReviewRes.body.data.id);

      // Both reviews exist
      const reviews = await prisma.review.findMany({
        where: { bookingId },
        orderBy: { direction: 'asc' },
      });
      expect(reviews).toHaveLength(2);
    });
  },
);
