/**
 * Week 5 — Matching Service Integration Tests
 *
 * Tests the deterministic matching algorithm against real PostgreSQL.
 * Verifies ranking, filtering, and edge cases.
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
import { findMatchingWorkers } from '../services/matchingService';

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
    data: {
      phone: `${PREFIX}-user-${idx}`,
      role,
    },
    select: { id: true },
  });
  tempUserIds.push(user.id);
  return user.id;
}

async function createTempClient(): Promise<string> {
  const userId = await createTempUser('CLIENT');
  const client = await prisma.clientProfile.create({
    data: { userId },
    select: { id: true },
  });
  tempClientIds.push(client.id);
  return client.id;
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
  status?: string;
  rating?: number;
  completedJobsCount?: number;
  isPriorityListed?: boolean;
  categoryId?: string;
  areaId?: string;
  availabilityStatus?: string;
}): Promise<string> {
  const idx = tempWorkerIds.length;
  const worker = await prisma.workerProfile.create({
    data: {
      name: `${PREFIX}-worker-${idx}`,
      phone: `${PREFIX}-wphone-${idx}`,
      status: (opts.status ?? 'APPROVED') as never,
      rating: opts.rating ?? 0,
      completedJobsCount: opts.completedJobsCount ?? 0,
      isPriorityListed: opts.isPriorityListed ?? false,
    },
    select: { id: true },
  });
  tempWorkerIds.push(worker.id);

  if (opts.categoryId) {
    await prisma.workerCategory.create({
      data: { workerId: worker.id, categoryId: opts.categoryId },
    });
  }
  if (opts.areaId) {
    await prisma.workerServiceArea.create({
      data: { workerId: worker.id, areaId: opts.areaId },
    });
  }
  if (opts.availabilityStatus) {
    await prisma.workerAvailability.create({
      data: {
        workerId: worker.id,
        status: opts.availabilityStatus as never,
        updateSource: 'AUTO_EXPIRY',
      },
    });
  }

  return worker.id;
}

async function createTempOpenJob(categoryId: string, areaId: string, clientId: string): Promise<string> {
  const job = await prisma.jobRequest.create({
    data: {
      clientId,
      categoryId,
      areaId,
      description: `${PREFIX} test job description`,
      type: 'OPEN',
      status: 'DRAFT',
    },
    select: { id: true },
  });
  tempJobRequestIds.push(job.id);
  return job.id;
}

describe.skipIf(!RUN_GATE || IS_PROD)('Week 5 — Matching Service Integration', () => {
  let categoryId: string;
  let areaId: string;
  let clientId: string;

  beforeAll(async () => {
    await rawClient.connect();
    categoryId = await createTempCategory();
    areaId = await createTempArea();
    clientId = await createTempClient();
  });

  afterAll(async () => {
    // Clean up in reverse dependency order
    if (tempJobRequestIds.length > 0) {
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

  it('1. returns empty array when no matching workers exist', async () => {
    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    const matches = await findMatchingWorkers(jobId);
    expect(matches).toEqual([]);
  });

  it('2. returns workers sorted by rating DESC', async () => {
    const w1 = await createTempWorker({ categoryId, areaId, rating: 3.5 });
    const w2 = await createTempWorker({ categoryId, areaId, rating: 4.8 });
    const w3 = await createTempWorker({ categoryId, areaId, rating: 2.0 });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    const matches = await findMatchingWorkers(jobId);

    expect(matches).toHaveLength(3);
    expect(matches[0].workerId).toBe(w2); // highest rating
    expect(matches[1].workerId).toBe(w1);
    expect(matches[2].workerId).toBe(w3); // lowest rating
  });

  it('3. priority-listed workers rank first', async () => {
    const w1 = await createTempWorker({ categoryId, areaId, rating: 5.0, isPriorityListed: false });
    const w2 = await createTempWorker({ categoryId, areaId, rating: 2.0, isPriorityListed: true });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    const matches = await findMatchingWorkers(jobId);

    expect(matches[0].workerId).toBe(w2); // priority-listed despite lower rating
    expect(matches[1].workerId).toBe(w1);
  });

  it('4. filters out UNAVAILABLE workers', async () => {
    await createTempWorker({ categoryId, areaId, availabilityStatus: 'UNAVAILABLE' });
    const w2 = await createTempWorker({ categoryId, areaId, availabilityStatus: 'AVAILABLE' });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    const matches = await findMatchingWorkers(jobId);

    expect(matches).toHaveLength(1);
    expect(matches[0].workerId).toBe(w2);
  });

  it('5. respects maxMatches limit', async () => {
    for (let i = 0; i < 5; i++) {
      await createTempWorker({ categoryId, areaId, rating: 1 + i * 0.5 });
    }

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    const matches = await findMatchingWorkers(jobId, 3);

    expect(matches).toHaveLength(3);
  });

  it('6. assigns sequential rank starting at 1', async () => {
    await createTempWorker({ categoryId, areaId, rating: 3.0 });
    await createTempWorker({ categoryId, areaId, rating: 4.0 });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    const matches = await findMatchingWorkers(jobId);

    expect(matches[0].rank).toBe(1);
    expect(matches[1].rank).toBe(2);
  });

  it('7. only includes workers matching the specific category+area', async () => {
    const otherCategory = await createTempCategory();
    const otherArea = await createTempArea();

    // Worker in right category, wrong area
    await createTempWorker({ categoryId, areaId: otherArea });
    // Worker in wrong category, right area
    await createTempWorker({ categoryId: otherCategory, areaId });
    // Worker in right category + right area
    const correct = await createTempWorker({ categoryId, areaId });

    const jobId = await createTempOpenJob(categoryId, areaId, clientId);
    const matches = await findMatchingWorkers(jobId);

    expect(matches).toHaveLength(1);
    expect(matches[0].workerId).toBe(correct);
  });
});
