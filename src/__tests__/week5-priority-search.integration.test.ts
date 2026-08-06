/**
 * Week 5 — Priority Listing in Search Integration Tests
 *
 * Verifies that isPriorityListed workers appear first in public search
 * results and that the isPriorityListed field is exposed in the DTO.
 *
 * Safety gate: refuses to run unless RUN_DB_INTEGRATION_TESTS=true
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';

const RUN_GATE = process.env.RUN_DB_INTEGRATION_TESTS === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!RUN_GATE || IS_PROD) {
  console.log('Integration tests skipped: set RUN_DB_INTEGRATION_TESTS=true');
}

import 'dotenv/config';
import { createApp } from '../app';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });
const app = createApp();

const NS = randomUUID();
const PREFIX = `__test_${NS.substring(0, 8)}`;

const tempWorkerIds: string[] = [];
const tempCategoryIds: string[] = [];
const tempAreaIds: string[] = [];

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
  areaId: string;
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

  await prisma.workerServiceArea.create({
    data: { workerId: worker.id, areaId: opts.areaId },
  });

  return worker.id;
}

describe.skipIf(!RUN_GATE || IS_PROD)('Week 5 — Priority Listing in Search Integration', () => {
  beforeAll(async () => {
    await rawClient.connect();
  });

  afterAll(async () => {
    if (tempWorkerIds.length > 0) {
      await rawClient.query(`DELETE FROM "worker_service_areas" WHERE "workerId" = ANY($1::text[])`, [tempWorkerIds]);
      await rawClient.query(`DELETE FROM "WorkerProfile" WHERE "id" = ANY($1::text[])`, [tempWorkerIds]);
    }
    if (tempCategoryIds.length > 0) {
      await rawClient.query(`DELETE FROM "Category" WHERE "id" = ANY($1::text[])`, [tempCategoryIds]);
    }
    if (tempAreaIds.length > 0) {
      await rawClient.query(`DELETE FROM "Area" WHERE "id" = ANY($1::text[])`, [tempAreaIds]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('1. search response includes isPriorityListed field', async () => {
    const areaId = await createTempArea();
    await createTempWorker({ areaId, isPriorityListed: true });

    const res = await request(app).get(`/api/v1/workers?areaId=${areaId}`);
    expect(res.status).toBe(200);
    for (const w of res.body.data.data) {
      expect(w).toHaveProperty('isPriorityListed');
      expect(typeof w.isPriorityListed).toBe('boolean');
    }
  });

  it('2. priority-listed workers appear before non-priority workers', async () => {
    const areaId = await createTempArea();

    // Non-priority worker with high rating
    const regular = await createTempWorker({ areaId, rating: 5.0, isPriorityListed: false });
    // Priority worker with low rating
    const priority = await createTempWorker({ areaId, rating: 1.0, isPriorityListed: true });

    const res = await request(app).get(`/api/v1/workers?areaId=${areaId}`);
    expect(res.status).toBe(200);

    const ids = res.body.data.data.map((w: { id: string }) => w.id);
    const priorityIdx = ids.indexOf(priority);
    const regularIdx = ids.indexOf(regular);

    expect(priorityIdx).toBeGreaterThanOrEqual(0);
    expect(regularIdx).toBeGreaterThanOrEqual(0);
    expect(priorityIdx).toBeLessThan(regularIdx);
  });

  it('3. among priority-listed workers, higher rating still ranks first', async () => {
    const areaId = await createTempArea();

    const priorityLow = await createTempWorker({ areaId, rating: 2.0, isPriorityListed: true });
    const priorityHigh = await createTempWorker({ areaId, rating: 4.5, isPriorityListed: true });

    const res = await request(app).get(`/api/v1/workers?areaId=${areaId}`);
    expect(res.status).toBe(200);

    const ids = res.body.data.data.map((w: { id: string }) => w.id);
    const highIdx = ids.indexOf(priorityHigh);
    const lowIdx = ids.indexOf(priorityLow);

    expect(highIdx).toBeLessThan(lowIdx);
  });
});
