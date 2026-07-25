/**
 * Week 3 worker update and CNIC upload route tests.
 *
 * Mocks auth middleware and workerServiceWeek3 to avoid database access.
 * Uses a fake storage adapter for CNIC upload tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AppError, ErrorCode } from '../../lib/errors';

// --- Mocks ------------------------------------------------------------------

vi.mock('../../config/env', () => ({
  env: {
    databaseUrl: 'postgresql://dummy:dummy@localhost:5432/dummy',
    directUrl: 'postgresql://dummy:dummy@localhost:5432/dummy',
    supabaseUrl: 'https://dummy.supabase.co',
    supabaseAnonKey: 'dummy-anon-key',
    supabaseServiceRoleKey: 'dummy-service-key',
    port: 3000,
    nodeEnv: 'test',
    isProduction: false,
  },
}));

vi.mock('../../middleware/auth', () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: (...roles: string[]) =>
    (req: Request, _res: Response, next: NextFunction) => {
      if (!req.user || !roles.includes(req.user.role)) {
        return next(new AppError(403, ErrorCode.AUTH_FORBIDDEN, 'Insufficient permissions'));
      }
      next();
    },
}));

vi.mock('../../services/workerService', () => ({
  createWorker: vi.fn(),
  verifyWorker: vi.fn(),
}));

const { mockUpdateWorker, mockUploadCnic } = vi.hoisted(() => ({
  mockUpdateWorker: vi.fn(),
  mockUploadCnic: vi.fn(),
}));

vi.mock('../../services/workerServiceWeek3', () => ({
  updateWorker: mockUpdateWorker,
  uploadCnicDocuments: mockUploadCnic,
  MAX_CNIC_FILE_SIZE: 5 * 1024 * 1024,
  ACCEPTED_MIME_TYPES: new Set(['image/jpeg', 'image/png', 'image/webp']),
}));

vi.mock('../../services/supabaseStorageAdapter', () => ({
  createSupabaseStorageAdapter: vi.fn(() => ({})),
}));

vi.mock('../../lib/prisma', () => ({ default: {} }));
vi.mock('../../lib/supabase', () => ({ supabase: {} }));

import workerRoutes from '../workers';
import { errorMiddleware } from '../../lib/errors';
import type { AuthPrincipal } from '../../types/auth';

// --- Helpers ----------------------------------------------------------------

function createAppWithRole(role: AuthPrincipal['role'] | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      req.user = { userId: 'mock-user-id', authUserId: 'mock-auth-id', role };
    }
    next();
  });
  app.use('/api/v1/workers', workerRoutes);
  app.use(errorMiddleware);
  return app;
}

const mockUpdateResult = {
  id: 'worker-1',
  name: 'Updated Worker',
  status: 'PENDING_APPROVAL',
  cnicRecorded: true,
  cnicFrontUploaded: false,
  cnicBackUploaded: false,
  identityChecked: true,
  phoneConfirmed: false,
  referenceStatus: 'UNVERIFIED',
  backgroundChecked: false,
  skillAssessed: false,
  categories: [{ id: 'cat-1', name: 'Electrician' }],
  serviceAreas: [{ id: 'area-1', name: 'Karachi' }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Update Tests -----------------------------------------------------------

describe('PATCH /api/v1/workers/:id — authorization', () => {
  it('rejects unauthenticated request', async () => {
    const app = createAppWithRole(null);
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ name: 'Updated' });

    expect(res.status).toBe(403);
  });

  it('rejects CLIENT role', async () => {
    const app = createAppWithRole('CLIENT');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ name: 'Updated' });

    expect(res.status).toBe(403);
  });

  it('allows AGENT to update', async () => {
    mockUpdateWorker.mockResolvedValue(mockUpdateResult);
    const app = createAppWithRole('AGENT');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ name: 'Updated' });

    expect(res.status).toBe(200);
    expect(mockUpdateWorker).toHaveBeenCalledOnce();
  });

  it('allows ADMIN to update', async () => {
    mockUpdateWorker.mockResolvedValue(mockUpdateResult);
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ name: 'Updated' });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/v1/workers/:id — field restrictions', () => {
  it('rejects rating in body', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ rating: 5 });

    expect(res.status).toBe(400);
    expect(mockUpdateWorker).not.toHaveBeenCalled();
  });

  it('rejects completedJobsCount in body', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ completedJobsCount: 10 });

    expect(res.status).toBe(400);
  });

  it('rejects referenceVerifiedById in body', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ referenceVerifiedById: 'user-1' });

    expect(res.status).toBe(400);
  });

  it('rejects referenceVerifiedAt in body', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ referenceVerifiedAt: '2026-07-24T00:00:00Z' });

    expect(res.status).toBe(400);
  });

  it('rejects status in body', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ status: 'APPROVED' });

    expect(res.status).toBe(400);
  });

  it('rejects agentId in body', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ agentId: 'other-agent' });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/v1/workers/:id — response safety', () => {
  it('does not expose CNIC number or paths', async () => {
    mockUpdateWorker.mockResolvedValue(mockUpdateResult);
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ name: 'Updated' });

    expect(res.body.data).not.toHaveProperty('cnicNumber');
    expect(res.body.data).not.toHaveProperty('cnicFrontPath');
    expect(res.body.data).not.toHaveProperty('cnicBackPath');
    expect(res.body.data).not.toHaveProperty('phone');
  });
});

describe('PATCH /api/v1/workers/:id — error handling', () => {
  it('returns 404 when worker not found', async () => {
    mockUpdateWorker.mockImplementation(async () => {
      throw new AppError(404, ErrorCode.WORKER_NOT_FOUND, 'Worker was not found');
    });
    const app = createAppWithRole('ADMIN');
    const res = await request(app).patch('/api/v1/workers/nonexistent').send({ name: 'Updated' });

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid category IDs', async () => {
    mockUpdateWorker.mockImplementation(async () => {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'One or more category IDs not found');
    });
    const app = createAppWithRole('AGENT');
    const res = await request(app).patch('/api/v1/workers/worker-1').send({ categoryIds: ['bad-cat'] });

    expect(res.status).toBe(400);
  });
});
