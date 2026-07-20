/**
 * Worker route authorization and behavior tests.
 *
 * These tests mock the auth middleware to inject different roles
 * and mock the workerService to avoid database access. They verify:
 *
 * - Client cannot create workers
 * - Agent can create workers
 * - Client cannot approve workers
 * - Agent cannot approve workers
 * - Admin can approve or suspend workers
 * - Invalid phone is rejected
 * - Duplicate phone returns 409
 * - Invalid state transitions return 422
 * - Missing worker returns 404
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AppError, ErrorCode } from '../../lib/errors';

// --- Mocks ------------------------------------------------------------------

// Mock env config so no real env vars are needed
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

// Mock the auth middleware — authenticate is a no-op (test injects req.user),
// but requireRole uses the real role-checking logic.
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

// Mock the workerService so no DB is needed
vi.mock('../../services/workerService', () => ({
  createWorker: vi.fn(),
  verifyWorker: vi.fn(),
}));

// Mock prisma (not used directly in routes, but imported transitively)
vi.mock('../../lib/prisma', () => ({
  default: {},
}));

// Mock supabase (not used directly in worker routes)
vi.mock('../../lib/supabase', () => ({
  supabase: {},
}));

import { createWorker, verifyWorker } from '../../services/workerService';
import workerRoutes from '../workers';
import { errorMiddleware } from '../../lib/errors';
import type { AuthPrincipal } from '../../types/auth';

// --- Helpers ----------------------------------------------------------------

/** Create an Express app with a forced auth role (bypasses Supabase). */
function createAppWithRole(role: AuthPrincipal['role'] | null) {
  const app = express();
  app.use(express.json());

  // Inject a mock principal instead of running real auth
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      req.user = {
        userId: 'mock-user-id',
        authUserId: 'mock-auth-id',
        role,
      };
    }
    next();
  });

  app.use('/api/v1/workers', workerRoutes);
  app.use(errorMiddleware);
  return app;
}

const mockWorkerDTO = {
  id: 'worker-1',
  name: 'Test Worker',
  phone: '+923001234567',
  status: 'PENDING_APPROVAL' as const,
  suspensionReason: null,
  agentId: 'mock-user-id',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe('POST /api/v1/workers — authorization', () => {
  it('rejects CLIENT from creating workers (403)', async () => {
    const app = createAppWithRole('CLIENT');
    const res = await request(app)
      .post('/api/v1/workers')
      .send({ name: 'Worker', phone: '+923001234567' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_FORBIDDEN);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('allows AGENT to create workers', async () => {
    vi.mocked(createWorker).mockResolvedValue(mockWorkerDTO);
    const app = createAppWithRole('AGENT');
    const res = await request(app)
      .post('/api/v1/workers')
      .send({ name: 'Worker', phone: '+923001234567' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it('rejects ADMIN from creating workers (403 — only AGENT can onboard)', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app)
      .post('/api/v1/workers')
      .send({ name: 'Worker', phone: '+923001234567' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_FORBIDDEN);
    expect(createWorker).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/workers — validation', () => {
  it('rejects missing name', async () => {
    const app = createAppWithRole('AGENT');
    const res = await request(app)
      .post('/api/v1/workers')
      .send({ phone: '+923001234567' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects missing phone', async () => {
    const app = createAppWithRole('AGENT');
    const res = await request(app)
      .post('/api/v1/workers')
      .send({ name: 'Worker' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects invalid Pakistani phone format', async () => {
    vi.mocked(createWorker).mockImplementation(async () => {
      throw new AppError(400, ErrorCode.INVALID_PHONE, 'Invalid Pakistani phone number format');
    });
    const app = createAppWithRole('AGENT');
    const res = await request(app)
      .post('/api/v1/workers')
      .send({ name: 'Worker', phone: '12345' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.INVALID_PHONE);
  });

  it('returns 409 for duplicate phone', async () => {
    vi.mocked(createWorker).mockImplementation(async () => {
      throw new AppError(409, ErrorCode.WORKER_DUPLICATE_PHONE, 'A worker with this phone number already exists');
    });
    const app = createAppWithRole('AGENT');
    const res = await request(app)
      .post('/api/v1/workers')
      .send({ name: 'Worker', phone: '+923001234567' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ErrorCode.WORKER_DUPLICATE_PHONE);
  });
});

describe('PATCH /api/v1/workers/:id/verify — authorization', () => {
  it('rejects CLIENT from approving workers (403)', async () => {
    const app = createAppWithRole('CLIENT');
    const res = await request(app)
      .patch('/api/v1/workers/worker-1/verify')
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_FORBIDDEN);
    expect(verifyWorker).not.toHaveBeenCalled();
  });

  it('rejects AGENT from approving workers (403)', async () => {
    const app = createAppWithRole('AGENT');
    const res = await request(app)
      .patch('/api/v1/workers/worker-1/verify')
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_FORBIDDEN);
    expect(verifyWorker).not.toHaveBeenCalled();
  });

  it('allows ADMIN to approve workers', async () => {
    vi.mocked(verifyWorker).mockResolvedValue({ ...mockWorkerDTO, status: 'APPROVED' });
    const app = createAppWithRole('ADMIN');
    const res = await request(app)
      .patch('/api/v1/workers/worker-1/verify')
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('APPROVED');
    expect(verifyWorker).toHaveBeenCalledOnce();
  });

  it('allows ADMIN to suspend workers', async () => {
    vi.mocked(verifyWorker).mockResolvedValue({ ...mockWorkerDTO, status: 'SUSPENDED', suspensionReason: 'Fraud' });
    const app = createAppWithRole('ADMIN');
    const res = await request(app)
      .patch('/api/v1/workers/worker-1/verify')
      .send({ status: 'SUSPENDED', reason: 'Fraud' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUSPENDED');
    expect(res.body.data.suspensionReason).toBe('Fraud');
  });
});

describe('PATCH /api/v1/workers/:id/verify — error handling', () => {
  it('returns 404 when worker does not exist', async () => {
    vi.mocked(verifyWorker).mockImplementation(async () => {
      throw new AppError(404, ErrorCode.WORKER_NOT_FOUND, 'Worker was not found');
    });
    const app = createAppWithRole('ADMIN');
    const res = await request(app)
      .patch('/api/v1/workers/nonexistent/verify')
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(ErrorCode.WORKER_NOT_FOUND);
  });

  it('returns 422 for invalid state transition', async () => {
    vi.mocked(verifyWorker).mockImplementation(async () => {
      throw new AppError(422, ErrorCode.WORKER_INVALID_TRANSITION, 'Cannot transition from SUSPENDED to APPROVED');
    });
    const app = createAppWithRole('ADMIN');
    const res = await request(app)
      .patch('/api/v1/workers/worker-1/verify')
      .send({ status: 'APPROVED' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(ErrorCode.WORKER_INVALID_TRANSITION);
  });

  it('rejects arbitrary status values', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app)
      .patch('/api/v1/workers/worker-1/verify')
      .send({ status: 'PENDING_APPROVAL' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects reason on APPROVED status', async () => {
    const app = createAppWithRole('ADMIN');
    const res = await request(app)
      .patch('/api/v1/workers/worker-1/verify')
      .send({ status: 'APPROVED', reason: 'should not be here' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
