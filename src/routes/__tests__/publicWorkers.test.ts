/**
 * Public worker search and detail route tests.
 *
 * Mocks Prisma to avoid database access. Verifies:
 * - No authentication required
 * - Only APPROVED workers are returned
 * - Filtering by categoryId and areaId
 * - Pagination defaults and limits
 * - Ordering by rating desc, completedJobsCount desc, id asc
 * - Forbidden sensitive keys are absent recursively
 * - Non-approved workers return 404 on detail
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// --- Mocks ------------------------------------------------------------------

vi.mock('../../config/env', () => ({
  env: {
    databaseUrl: 'postgresql://dummy:dummy@localhost:5432/dummy',
    directUrl: 'postgresql://dummy:dummy@localhost:5432/dummy',
    supabaseUrl: 'https://dummy.supabase.co',
    supabaseAnonKey: 'dummy-anon-key',
    supabaseServiceRoleKey: undefined,
    port: 3000,
    nodeEnv: 'test',
    isProduction: false,
  },
}));

const { mockPrismaObj } = vi.hoisted(() => ({
  mockPrismaObj: {
    workerProfile: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    category: { findMany: vi.fn() },
    area: { findMany: vi.fn() },
  },
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrismaObj }));

vi.mock('../../lib/supabase', () => ({ supabase: {} }));

import publicWorkerRoutes from '../publicWorkers';
import { errorMiddleware } from '../../lib/errors';
import { findForbiddenKey } from '../../lib/publicWorkerDto';

// --- Helpers ----------------------------------------------------------------

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workers', publicWorkerRoutes);
  app.use(errorMiddleware);
  return app;
}

/** A mock approved worker as returned by Prisma with the public select. */
function mockApprovedWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 'worker-1',
    name: 'Test Worker',
    status: 'APPROVED',
    rating: { toString: () => '4.50' } as unknown as number,
    ratingCount: 10,
    completedJobsCount: 5,
    isPriorityListed: false,
    identityChecked: true,
    phoneConfirmed: true,
    referenceStatus: 'UNVERIFIED',
    backgroundChecked: false,
    skillAssessed: true,
    categories: [{ category: { id: 'cat-1', name: 'Electrician' } }],
    serviceAreas: [{ area: { id: 'area-1', name: 'Karachi', parentId: null } }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Search Tests -----------------------------------------------------------

describe('GET /api/v1/workers — search', () => {
  it('returns 200 without authentication', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(0);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns only APPROVED workers', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([mockApprovedWorker()]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(1);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers');

    expect(res.body.data.data).toHaveLength(1);
    expect(res.body.data.data[0].id).toBe('worker-1');
  });

  it('passes status APPROVED in the where clause', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(0);

    const app = createTestApp();
    await request(app).get('/api/v1/workers');

    const where = mockPrismaObj.workerProfile.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('APPROVED');
  });

  it('filters by categoryId', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(0);

    const app = createTestApp();
    await request(app).get('/api/v1/workers?categoryId=cat-1');

    const where = mockPrismaObj.workerProfile.findMany.mock.calls[0][0].where;
    expect(where.categories).toEqual({ some: { categoryId: 'cat-1' } });
  });

  it('filters by areaId', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(0);

    const app = createTestApp();
    await request(app).get('/api/v1/workers?areaId=area-1');

    const where = mockPrismaObj.workerProfile.findMany.mock.calls[0][0].where;
    expect(where.serviceAreas).toEqual({ some: { areaId: 'area-1' } });
  });

  it('applies both categoryId and areaId filters', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(0);

    const app = createTestApp();
    await request(app).get('/api/v1/workers?categoryId=cat-1&areaId=area-1');

    const where = mockPrismaObj.workerProfile.findMany.mock.calls[0][0].where;
    expect(where.categories).toEqual({ some: { categoryId: 'cat-1' } });
    expect(where.serviceAreas).toEqual({ some: { areaId: 'area-1' } });
  });

  it('defaults page to 1 and limit to 20', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(0);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers');

    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(20);
  });

  it('rejects limit above 50', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers?limit=51');

    expect(res.status).toBe(400);
  });

  it('rejects invalid page', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers?page=0');

    expect(res.status).toBe(400);
  });

  it('orders by isPriorityListed desc, rating desc, completedJobsCount desc, id asc', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(0);

    const app = createTestApp();
    await request(app).get('/api/v1/workers');

    const orderBy = mockPrismaObj.workerProfile.findMany.mock.calls[0][0].orderBy;
    expect(orderBy).toEqual([
      { isPriorityListed: 'desc' },
      { rating: 'desc' },
      { completedJobsCount: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('returns pagination metadata', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(15);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers?limit=10');

    expect(res.body.data.total).toBe(15);
    expect(res.body.data.totalPages).toBe(2);
  });

  it('returns 200 with empty array for no results', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(0);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers');

    expect(res.status).toBe(200);
    expect(res.body.data.data).toEqual([]);
  });

  it('serializes Decimal rating as a number', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([mockApprovedWorker()]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(1);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers');

    expect(typeof res.body.data.data[0].rating).toBe('number');
  });

  it('excludes all forbidden sensitive keys recursively', async () => {
    mockPrismaObj.workerProfile.findMany.mockResolvedValue([mockApprovedWorker()]);
    mockPrismaObj.workerProfile.count.mockResolvedValue(1);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers');

    const forbidden = findForbiddenKey(res.body.data.data[0]);
    expect(forbidden).toBeNull();
  });
});

// --- Detail Tests -----------------------------------------------------------

describe('GET /api/v1/workers/:id — detail', () => {
  it('returns 200 for an approved worker', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(mockApprovedWorker());

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/worker-1');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('worker-1');
  });

  it('returns 404 for unknown worker', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(null);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/nonexistent');

    expect(res.status).toBe(404);
  });

  it('returns 404 for pending worker', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(
      mockApprovedWorker({ status: 'PENDING_APPROVAL' }),
    );

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/worker-1');

    expect(res.status).toBe(404);
  });

  it('returns 404 for suspended worker', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(
      mockApprovedWorker({ status: 'SUSPENDED' }),
    );

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/worker-1');

    expect(res.status).toBe(404);
  });

  it('includes categories as safe summaries', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(mockApprovedWorker());

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/worker-1');

    expect(res.body.data.categories).toEqual([{ id: 'cat-1', name: 'Electrician' }]);
  });

  it('includes service areas as safe summaries', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(mockApprovedWorker());

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/worker-1');

    expect(res.body.data.serviceAreas).toEqual([{ id: 'area-1', name: 'Karachi', parentId: null }]);
  });

  it('includes explicit verification badges', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(mockApprovedWorker());

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/worker-1');

    expect(res.body.data.verification).toEqual({
      identityChecked: true,
      phoneConfirmed: true,
      referenceChecked: false,
      backgroundChecked: false,
      skillAssessed: true,
    });
  });

  it('excludes all forbidden sensitive keys recursively', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(mockApprovedWorker());

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/worker-1');

    const forbidden = findForbiddenKey(res.body.data);
    expect(forbidden).toBeNull();
  });

  it('never returns phone or document paths', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(mockApprovedWorker());

    const app = createTestApp();
    const res = await request(app).get('/api/v1/workers/worker-1');

    expect(res.body.data).not.toHaveProperty('phone');
    expect(res.body.data).not.toHaveProperty('cnicNumber');
    expect(res.body.data).not.toHaveProperty('cnicFrontPath');
    expect(res.body.data).not.toHaveProperty('cnicBackPath');
  });
});
