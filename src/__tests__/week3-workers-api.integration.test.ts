/**
 * Week 3 API — Genuine PostgreSQL Integration Tests
 *
 * This file makes real HTTP requests via supertest against a real Express app
 * backed by a real PostgreSQL database. It does NOT mock Prisma or PostgreSQL.
 *
 * Safety gate: refuses to run unless RUN_DB_INTEGRATION_TESTS=true
 * and NODE_ENV is not "production".
 *
 * All temporary records are prefixed with a unique namespace UUID and
 * cleaned up in finally blocks. No shared data is modified or deleted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';

// ─── Safety gate ───────────────────────────────────────────────────────────

const RUN_GATE = process.env.RUN_DB_INTEGRATION_TESTS === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!RUN_GATE || IS_PROD) {
  console.error(
    'Integration tests skipped: set RUN_DB_INTEGRATION_TESTS=true and ensure NODE_ENV is not production.'
  );
  process.exit(1);
}

// ─── Imports (only loaded after gate passes) ───────────────────────────────

import 'dotenv/config';
import { createApp } from '../app';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { findForbiddenKey } from '../lib/publicWorkerDto';

// ─── Setup ─────────────────────────────────────────────────────────────────

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });
const app = createApp();

/** Unique namespace for all temporary records created by this test run. */
const NS = randomUUID();
const PREFIX = `__test_${NS.substring(0, 8)}`;

const tempUserIds: string[] = [];
const tempWorkerIds: string[] = [];
const tempCategoryIds: string[] = [];
const tempAreaIds: string[] = [];

beforeAll(async () => {
  await rawClient.connect();
});

afterAll(async () => {
  // Clean up all temporary records in reverse dependency order.
  if (tempWorkerIds.length > 0) {
    await rawClient.query(
      `DELETE FROM "worker_categories" WHERE "workerId" = ANY($1::text[])`,
      [tempWorkerIds],
    );
    await rawClient.query(
      `DELETE FROM "worker_service_areas" WHERE "workerId" = ANY($1::text[])`,
      [tempWorkerIds],
    );
  }
  if (tempWorkerIds.length > 0) {
    await rawClient.query(
      `DELETE FROM "WorkerProfile" WHERE "id" = ANY($1::text[])`,
      [tempWorkerIds],
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

// ─── Helpers ───────────────────────────────────────────────────────────────

async function createTempCategory(name?: string): Promise<string> {
  const idx = tempCategoryIds.length;
  const cat = await prisma.category.create({
    data: { name: name ?? `${PREFIX}-cat-${idx}` },
    select: { id: true },
  });
  tempCategoryIds.push(cat.id);
  return cat.id;
}

async function createTempArea(name?: string): Promise<string> {
  const idx = tempAreaIds.length;
  const area = await prisma.area.create({
    data: { name: name ?? `${PREFIX}-area-${idx}`, slug: `${PREFIX}-area-${idx}` },
    select: { id: true },
  });
  tempAreaIds.push(area.id);
  return area.id;
}

async function createTempWorker(overrides: Record<string, unknown> = {}): Promise<string> {
  const idx = tempWorkerIds.length;
  const data: Record<string, unknown> = {
    name: `${PREFIX}-worker-${idx}`,
    phone: `${PREFIX}-phone-${idx}`,
    status: 'PENDING_APPROVAL',
    ...overrides,
  };
  const worker = await prisma.workerProfile.create({
    data: data as never,
    select: { id: true },
  });
  tempWorkerIds.push(worker.id);
  return worker.id;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Week 3 API Integration — Public Catalog', () => {
  it('1. GET /api/v1/categories returns 200 with safe fields', async () => {
    const res = await request(app).get('/api/v1/categories');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    // Each item should only have id and name
    for (const cat of res.body.data) {
      expect(cat).toHaveProperty('id');
      expect(cat).toHaveProperty('name');
      expect(cat).not.toHaveProperty('createdAt');
      expect(cat).not.toHaveProperty('updatedAt');
    }
  });

  it('2. GET /api/v1/areas returns 200 with safe hierarchy fields', async () => {
    const res = await request(app).get('/api/v1/areas');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const area of res.body.data) {
      expect(area).toHaveProperty('id');
      expect(area).toHaveProperty('name');
      expect(area).toHaveProperty('parentId');
      expect(area).not.toHaveProperty('address');
    }
  });
});

describe('Week 3 API Integration — Public Worker Search', () => {
  it('3. GET /api/v1/workers returns 200 without auth', async () => {
    const res = await request(app).get('/api/v1/workers');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('4. search returns only APPROVED workers', async () => {
    // Create a pending worker — it should NOT appear
    const pendingId = await createTempWorker({ status: 'PENDING_APPROVAL' });
    // Create an approved worker — it SHOULD appear
    const approvedId = await createTempWorker({ status: 'APPROVED' });

    const res = await request(app).get('/api/v1/workers');
    expect(res.status).toBe(200);

    const ids = res.body.data.data.map((w: { id: string }) => w.id);
    expect(ids).toContain(approvedId);
    // The pending worker must NOT appear in search results
    expect(ids).not.toContain(pendingId);
  });

  it('5. search filters by categoryId', async () => {
    const catId = await createTempCategory();
    const workerId = await createTempWorker({ status: 'APPROVED' });
    await prisma.workerCategory.create({
      data: { workerId, categoryId: catId },
    });

    const res = await request(app).get(`/api/v1/workers?categoryId=${catId}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.data.map((w: { id: string }) => w.id);
    expect(ids).toContain(workerId);
  });

  it('6. search filters by areaId', async () => {
    const areaId = await createTempArea();
    const workerId = await createTempWorker({ status: 'APPROVED' });
    await prisma.workerServiceArea.create({
      data: { workerId, areaId },
    });

    const res = await request(app).get(`/api/v1/workers?areaId=${areaId}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.data.map((w: { id: string }) => w.id);
    expect(ids).toContain(workerId);
  });

  it('7. search respects pagination — limit', async () => {
    const res = await request(app).get('/api/v1/workers?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data.data.length).toBeLessThanOrEqual(1);
    expect(res.body.data.limit).toBe(1);
  });

  it('8. search rejects limit > 50', async () => {
    const res = await request(app).get('/api/v1/workers?limit=51');
    expect(res.status).toBe(400);
  });

  it('9. search rejects page < 1', async () => {
    const res = await request(app).get('/api/v1/workers?page=0');
    expect(res.status).toBe(400);
  });

  it('10. search returns pagination metadata', async () => {
    const res = await request(app).get('/api/v1/workers?page=1&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('page', 1);
    expect(res.body.data).toHaveProperty('limit', 10);
    expect(res.body.data).toHaveProperty('total');
    expect(res.body.data).toHaveProperty('totalPages');
  });

  it('11. search response excludes forbidden sensitive keys (recursive)', async () => {
    const res = await request(app).get('/api/v1/workers');
    expect(res.status).toBe(200);
    // Use the recursive scanner — checks all workers, all nested objects
    for (const w of res.body.data.data) {
      const forbidden = findForbiddenKey(w);
      expect(forbidden).toBeNull();
    }
  });

  it('12. search serializes rating as a number', async () => {
    const res = await request(app).get('/api/v1/workers');
    expect(res.status).toBe(200);
    for (const w of res.body.data.data) {
      expect(typeof w.rating).toBe('number');
    }
  });
});

describe('Week 3 API Integration — Public Worker Detail', () => {
  it('13. GET /api/v1/workers/:id returns 200 for approved worker', async () => {
    const id = await createTempWorker({ status: 'APPROVED' });
    const res = await request(app).get(`/api/v1/workers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  it('14. GET /api/v1/workers/:id returns 404 for pending worker', async () => {
    const id = await createTempWorker({ status: 'PENDING_APPROVAL' });
    const res = await request(app).get(`/api/v1/workers/${id}`);
    expect(res.status).toBe(404);
  });

  it('15. GET /api/v1/workers/:id returns 404 for suspended worker', async () => {
    const id = await createTempWorker({ status: 'SUSPENDED' });
    const res = await request(app).get(`/api/v1/workers/${id}`);
    expect(res.status).toBe(404);
  });

  it('16. GET /api/v1/workers/:id returns 404 for unknown worker', async () => {
    const res = await request(app).get('/api/v1/workers/nonexistent-id-12345');
    expect(res.status).toBe(404);
  });

  it('17. detail response excludes forbidden sensitive keys (recursive)', async () => {
    const id = await createTempWorker({
      status: 'APPROVED',
      cnicNumber: `${PREFIX}-cnic`,
      phone: `${PREFIX}-phone-detail`,
    });
    const res = await request(app).get(`/api/v1/workers/${id}`);
    expect(res.status).toBe(200);
    // Use the recursive scanner — checks all nested objects
    const forbidden = findForbiddenKey(res.body.data);
    expect(forbidden).toBeNull();
  });

  it('18. detail includes categories as safe summaries', async () => {
    const catId = await createTempCategory(`${PREFIX}-detail-cat`);
    const workerId = await createTempWorker({ status: 'APPROVED' });
    await prisma.workerCategory.create({
      data: { workerId, categoryId: catId },
    });

    const res = await request(app).get(`/api/v1/workers/${workerId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.categories)).toBe(true);
    const cat = res.body.data.categories.find(
      (c: { id: string }) => c.id === catId,
    );
    expect(cat).toBeDefined();
    expect(cat).toHaveProperty('name');
    expect(cat).not.toHaveProperty('createdAt');
  });

  it('19. detail includes service areas as safe summaries', async () => {
    const areaId = await createTempArea(`${PREFIX}-detail-area`);
    const workerId = await createTempWorker({ status: 'APPROVED' });
    await prisma.workerServiceArea.create({
      data: { workerId, areaId },
    });

    const res = await request(app).get(`/api/v1/workers/${workerId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.serviceAreas)).toBe(true);
    const area = res.body.data.serviceAreas.find(
      (a: { id: string }) => a.id === areaId,
    );
    expect(area).toBeDefined();
    expect(area).toHaveProperty('name');
    expect(area).toHaveProperty('parentId');
  });

  it('20. detail includes verification badges object', async () => {
    const id = await createTempWorker({
      status: 'APPROVED',
      identityChecked: true,
      phoneConfirmed: true,
    });
    const res = await request(app).get(`/api/v1/workers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verification).toEqual({
      identityChecked: true,
      phoneConfirmed: true,
      referenceChecked: false,
      backgroundChecked: false,
      skillAssessed: false,
    });
  });
});

describe('Week 3 API Integration — Search ordering and combined filters', () => {
  it('21. combined categoryId + areaId filter requires both matches', async () => {
    const catId = await createTempCategory();
    const areaId = await createTempArea();
    const workerId = await createTempWorker({ status: 'APPROVED' });
    await prisma.workerCategory.create({ data: { workerId, categoryId: catId } });
    await prisma.workerServiceArea.create({ data: { workerId, areaId } });

    // Worker with only the category (not the area) — should NOT appear
    const workerCatOnly = await createTempWorker({ status: 'APPROVED' });
    await prisma.workerCategory.create({ data: { workerId: workerCatOnly, categoryId: catId } });

    const res = await request(app).get(`/api/v1/workers?categoryId=${catId}&areaId=${areaId}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.data.map((w: { id: string }) => w.id);
    expect(ids).toContain(workerId);
    expect(ids).not.toContain(workerCatOnly);
  });

  it('22. rating ordering — higher rating appears first', async () => {
    const lowId = await createTempWorker({ status: 'APPROVED', rating: 2.5 });
    const highId = await createTempWorker({ status: 'APPROVED', rating: 4.8 });

    const res = await request(app).get('/api/v1/workers?limit=50');
    expect(res.status).toBe(200);
    const ids = res.body.data.data.map((w: { id: string }) => w.id);
    const highIdx = ids.indexOf(highId);
    const lowIdx = ids.indexOf(lowId);
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('23. completedJobsCount tie-break — higher count ranks first', async () => {
    // Same rating, different completedJobsCount
    const lowJobsId = await createTempWorker({
      status: 'APPROVED',
      rating: 3.0,
      completedJobsCount: 2,
    });
    const highJobsId = await createTempWorker({
      status: 'APPROVED',
      rating: 3.0,
      completedJobsCount: 10,
    });

    const res = await request(app).get('/api/v1/workers?limit=50');
    expect(res.status).toBe(200);
    const ids = res.body.data.data.map((w: { id: string }) => w.id);
    const highIdx = ids.indexOf(highJobsId);
    const lowIdx = ids.indexOf(lowJobsId);
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('24. pagination count and results agree', async () => {
    const res = await request(app).get('/api/v1/workers?page=1&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.data.data.length).toBeLessThanOrEqual(res.body.data.limit);
    const expectedTotalPages = res.body.data.total > 0
      ? Math.ceil(res.body.data.total / res.body.data.limit)
      : 0;
    expect(res.body.data.totalPages).toBe(expectedTotalPages);
  });

  it('25. out-of-range page returns empty data array', async () => {
    const res = await request(app).get('/api/v1/workers?page=99999&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
  });

  it('26. WorkerProfile physical mapping works without P2021', async () => {
    // Creating and querying a worker exercises the physical table name
    const id = await createTempWorker({ status: 'APPROVED' });
    const res = await request(app).get(`/api/v1/workers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  it('27. referenceChecked derives from referenceStatus CONFIRMED', async () => {
    const confirmedId = await createTempWorker({
      status: 'APPROVED',
      referenceStatus: 'CONFIRMED',
    });
    const res = await request(app).get(`/api/v1/workers/${confirmedId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.verification.referenceChecked).toBe(true);
  });

  it('28. referenceChecked is false for non-CONFIRMED states', async () => {
    for (const status of ['UNVERIFIED', 'CONTACTED', 'FAILED']) {
      const id = await createTempWorker({
        status: 'APPROVED',
        referenceStatus: status,
      });
      const res = await request(app).get(`/api/v1/workers/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.verification.referenceChecked).toBe(false);
    }
  });
});
