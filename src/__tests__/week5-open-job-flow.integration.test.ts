/**
 * Week 5 — Open Job Flow Integration Tests
 *
 * Tests the full OPEN job lifecycle: create → submit → batch invitations →
 * first-accept-wins → booking.
 *
 * Safety gate: refuses to run unless RUN_DB_INTEGRATION_TESTS=true
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

const RUN_GATE = process.env.RUN_DB_INTEGRATION_TESTS === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!RUN_GATE || IS_PROD) {
  console.log('Integration tests skipped: set RUN_DB_INTEGRATION_TESTS=true');
}

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { submitJobRequest } from '../services/jobRequestService';
import { respondToInvitation } from '../services/invitationService';
import { expireStaleInvitations } from '../services/expiryService';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });

const NS = randomUUID();
const PREFIX = `__test_${NS.substring(0, 8)}`;

const tempUserIds: string[] = [];
const tempWorkerIds: string[] = [];
const tempCategoryIds: string[] = [];
const tempAreaIds: string[] = [];
const tempClientIds: string[] = [];
const tempJobRequestIds: string[] = [];

async function createTempUser(role: 'CLIENT' | 'WORKER' | 'AGENT' | 'ADMIN' = 'CLIENT'): Promise<string> {
  const idx = tempUserIds.length;
  const user = await prisma.user.create({
    data: { phone: `${PREFIX}-user-${idx}`, role },
    select: { id: true },
  });
  tempUserIds.push(user.id);
  return user.id;
}

async function createTempClient(): Promise<{ clientId: string; userId: string }> {
  const userId = await createTempUser('CLIENT');
  const client = await prisma.clientProfile.create({
    data: { userId },
    select: { id: true },
  });
  tempClientIds.push(client.id);
  return { clientId: client.id, userId };
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

async function createTempWorker(opts: {
  categoryId?: string;
  areaId?: string;
  rating?: number;
  isPriorityListed?: boolean;
}): Promise<string> {
  const idx = tempWorkerIds.length;
  const worker = await prisma.workerProfile.create({
    data: {
      name: `${PREFIX}-worker-${idx}`,
      phone: `${PREFIX}-wphone-${idx}`,
      status: 'APPROVED',
      rating: opts.rating ?? 0,
      isPriorityListed: opts.isPriorityListed ?? false,
    },
    select: { id: true },
  });
  tempWorkerIds.push(worker.id);

  if (opts.categoryId) {
    await prisma.workerCategory.create({ data: { workerId: worker.id, categoryId: opts.categoryId } });
  }
  if (opts.areaId) {
    await prisma.workerServiceArea.create({ data: { workerId: worker.id, areaId: opts.areaId } });
  }
  return worker.id;
}

async function createTempOpenJob(categoryId: string, areaId: string, clientId: string): Promise<string> {
  const job = await prisma.jobRequest.create({
    data: {
      clientId,
      categoryId,
      areaId,
      description: `${PREFIX} open job description for testing`,
      type: 'OPEN',
      status: 'DRAFT',
    },
    select: { id: true },
  });
  tempJobRequestIds.push(job.id);
  return job.id;
}

describe.skipIf(!RUN_GATE || IS_PROD)('Week 5 — Open Job Flow Integration', () => {
  beforeAll(async () => {
    await rawClient.connect();
  });

  afterAll(async () => {
    if (tempJobRequestIds.length > 0) {
      await rawClient.query(`DELETE FROM "Booking" WHERE "jobRequestId" = ANY($1::text[])`, [tempJobRequestIds]);
      await rawClient.query(`DELETE FROM "JobInvitation" WHERE "jobRequestId" = ANY($1::text[])`, [tempJobRequestIds]);
      await rawClient.query(`DELETE FROM "JobRequest" WHERE "id" = ANY($1::text[])`, [tempJobRequestIds]);
    }
    if (tempClientIds.length > 0) {
      await rawClient.query(`DELETE FROM "ClientProfile" WHERE "id" = ANY($1::text[])`, [tempClientIds]);
    }
    if (tempWorkerIds.length > 0) {
      await rawClient.query(`DELETE FROM "WorkerAvailability" WHERE "workerId" = ANY($1::text[])`, [tempWorkerIds]);
      await rawClient.query(`DELETE FROM "worker_categories" WHERE "workerId" = ANY($1::text[])`, [tempWorkerIds]);
      await rawClient.query(`DELETE FROM "worker_service_areas" WHERE "workerId" = ANY($1::text[])`, [tempWorkerIds]);
      await rawClient.query(`DELETE FROM "WorkerProfile" WHERE "id" = ANY($1::text[])`, [tempWorkerIds]);
    }
    if (tempCategoryIds.length > 0) {
      await rawClient.query(`DELETE FROM "Category" WHERE "id" = ANY($1::text[])`, [tempCategoryIds]);
    }
    if (tempAreaIds.length > 0) {
      await rawClient.query(`DELETE FROM "Area" WHERE "id" = ANY($1::text[])`, [tempAreaIds]);
    }
    if (tempUserIds.length > 0) {
      await rawClient.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [tempUserIds]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('1. submitting OPEN job with matching workers creates batch invitations + MATCHING status', async () => {
    const categoryId = await createTempCategory();
    const areaId = await createTempArea();
    const { clientId, userId } = await createTempClient();

    await createTempWorker({ categoryId, areaId, rating: 4.0 });
    await createTempWorker({ categoryId, areaId, rating: 3.5 });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    await submitJobRequest(jobId, userId, {});

    const job = await prisma.jobRequest.findUnique({
      where: { id: jobId },
      select: { status: true, type: true },
    });
    expect(job!.status).toBe('MATCHING');

    const invitations = await prisma.jobInvitation.findMany({
      where: { jobRequestId: jobId },
      select: { status: true },
    });
    expect(invitations).toHaveLength(2);
    expect(invitations.every((i) => i.status === 'PENDING')).toBe(true);
  });

  it('2. first-accept-wins: accepting one invitation expires others + creates booking', async () => {
    const categoryId = await createTempCategory();
    const areaId = await createTempArea();
    const { clientId, userId } = await createTempClient();

    const w1 = await createTempWorker({ categoryId, areaId, rating: 4.0 });
    const w2 = await createTempWorker({ categoryId, areaId, rating: 3.5 });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    await submitJobRequest(jobId, userId, {});

    const invitations = await prisma.jobInvitation.findMany({
      where: { jobRequestId: jobId },
      select: { id: true, workerId: true },
    });

    const inv1 = invitations.find((i) => i.workerId === w1)!;
    const inv2 = invitations.find((i) => i.workerId === w2)!;

    // First worker accepts
    await respondToInvitation(inv1.id, w1, { status: 'ACCEPTED' });

    const job = await prisma.jobRequest.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job!.status).toBe('ACCEPTED');

    // Other invitation should be EXPIRED
    const otherInv = await prisma.jobInvitation.findUnique({
      where: { id: inv2.id },
      select: { status: true },
    });
    expect(otherInv!.status).toBe('EXPIRED');

    // Booking should exist
    const booking = await prisma.booking.findUnique({
      where: { jobRequestId: jobId },
      select: { id: true },
    });
    expect(booking).not.toBeNull();
  });

  it('3. rejecting all invitations on MATCHING job moves it to EXPIRED', async () => {
    const categoryId = await createTempCategory();
    const areaId = await createTempArea();
    const { clientId, userId } = await createTempClient();

    const w1 = await createTempWorker({ categoryId, areaId, rating: 4.0 });
    const w2 = await createTempWorker({ categoryId, areaId, rating: 3.5 });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    await submitJobRequest(jobId, userId, {});

    const invitations = await prisma.jobInvitation.findMany({
      where: { jobRequestId: jobId },
      select: { id: true, workerId: true },
    });

    // Reject all
    for (const inv of invitations) {
      await respondToInvitation(inv.id, inv.workerId, { status: 'REJECTED' });
    }

    const job = await prisma.jobRequest.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job!.status).toBe('EXPIRED');
  });

  it('4. rejecting one invitation keeps MATCHING while others are PENDING', async () => {
    const categoryId = await createTempCategory();
    const areaId = await createTempArea();
    const { clientId, userId } = await createTempClient();

    const w1 = await createTempWorker({ categoryId, areaId, rating: 4.0 });
    const w2 = await createTempWorker({ categoryId, areaId, rating: 3.5 });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    await submitJobRequest(jobId, userId, {});

    const invitations = await prisma.jobInvitation.findMany({
      where: { jobRequestId: jobId },
      select: { id: true, workerId: true },
    });

    const inv1 = invitations.find((i) => i.workerId === w1)!;
    await respondToInvitation(inv1.id, w1, { status: 'REJECTED' });

    const job = await prisma.jobRequest.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job!.status).toBe('MATCHING');
  });

  it('5. expiry service expires MATCHING jobs past their deadline', async () => {
    const categoryId = await createTempCategory();
    const areaId = await createTempArea();
    const { clientId, userId } = await createTempClient();

    await createTempWorker({ categoryId, areaId, rating: 4.0 });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    await submitJobRequest(jobId, userId, {});

    // Manually set expiresAt to the past
    await prisma.jobRequest.update({
      where: { id: jobId },
      data: { expiresAt: new Date(Date.now() - 60000) }, // 1 min ago
    });

    const result = await expireStaleInvitations();
    expect(result.expiredRequests).toBeGreaterThanOrEqual(1);

    const job = await prisma.jobRequest.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job!.status).toBe('EXPIRED');
  });
});
