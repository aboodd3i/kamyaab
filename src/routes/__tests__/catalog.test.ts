/**
 * Public catalog route tests — categories and areas.
 *
 * Mocks Prisma to avoid database access. Verifies:
 * - Endpoints are public (no auth required)
 * - Categories are ordered by name
 * - Only safe fields are returned
 * - Areas use safe hierarchy fields
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
    category: { findMany: vi.fn() },
    area: { findMany: vi.fn() },
    workerProfile: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrismaObj }));

vi.mock('../../lib/supabase', () => ({ supabase: {} }));

import categoryRoutes from '../categories';
import areaRoutes from '../areas';
import { errorMiddleware } from '../../lib/errors';

// --- Helpers ----------------------------------------------------------------

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/categories', categoryRoutes);
  app.use('/api/v1/areas', areaRoutes);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe('GET /api/v1/categories', () => {
  it('returns 200 without authentication', async () => {
    mockPrismaObj.category.findMany.mockResolvedValue([
      { id: 'cat-1', name: 'Electrician' },
      { id: 'cat-2', name: 'Plumber' },
    ]);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/categories');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it('orders categories by name ascending', async () => {
    mockPrismaObj.category.findMany.mockResolvedValue([
      { id: 'cat-1', name: 'AC Technician' },
      { id: 'cat-2', name: 'Electrician' },
    ]);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/categories');

    expect(res.body.data[0].name).toBe('AC Technician');
    expect(res.body.data[1].name).toBe('Electrician');
    expect(mockPrismaObj.category.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    );
  });

  it('returns only id and name', async () => {
    mockPrismaObj.category.findMany.mockResolvedValue([
      { id: 'cat-1', name: 'Electrician' },
    ]);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/categories');

    expect(res.body.data[0]).toEqual({ id: 'cat-1', name: 'Electrician' });
    expect(res.body.data[0]).not.toHaveProperty('createdAt');
    expect(res.body.data[0]).not.toHaveProperty('updatedAt');
  });
});

describe('GET /api/v1/areas', () => {
  it('returns 200 without authentication', async () => {
    mockPrismaObj.area.findMany.mockResolvedValue([
      { id: 'area-1', name: 'Karachi', parentId: null },
    ]);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/areas');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns safe hierarchy fields only', async () => {
    mockPrismaObj.area.findMany.mockResolvedValue([
      { id: 'area-1', name: 'Karachi', parentId: null },
      { id: 'area-2', name: 'East', parentId: 'area-1' },
    ]);

    const app = createTestApp();
    const res = await request(app).get('/api/v1/areas');

    expect(res.body.data[0]).toEqual({ id: 'area-1', name: 'Karachi', parentId: null });
    expect(res.body.data[1]).toEqual({ id: 'area-2', name: 'East', parentId: 'area-1' });
    expect(res.body.data[0]).not.toHaveProperty('address');
    expect(res.body.data[0]).not.toHaveProperty('exactAddress');
  });
});
