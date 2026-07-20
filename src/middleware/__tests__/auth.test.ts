/**
 * Auth middleware tests.
 *
 * Tests the real `authenticate` middleware with a mocked Supabase client
 * and mocked Prisma. Verifies:
 *
 * - Missing bearer token → 401 AUTH_MISSING_TOKEN
 * - Invalid bearer token → 401 AUTH_INVALID_TOKEN
 * - Expired/rejected token → 401 AUTH_INVALID_TOKEN
 * - Valid client token → req.user populated with CLIENT role
 * - Valid agent token → req.user populated with AGENT role
 * - Valid admin token → req.user populated with ADMIN role
 * - Internal user missing → 401 AUTH_USER_NOT_FOUND
 * - Role resolved from database, not request body
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
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

const { mockPrismaObj, mockSupabaseObj } = vi.hoisted(() => ({
  mockPrismaObj: {
    user: {
      findUnique: vi.fn(),
    },
  },
  mockSupabaseObj: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrismaObj }));
vi.mock('../../lib/supabase', () => ({ supabase: mockSupabaseObj }));

import { authenticate } from '../auth';
import { errorMiddleware, ErrorCode } from '../../lib/errors';

// --- Helpers ----------------------------------------------------------------

function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/protected', authenticate, (req: Request, res: Response) => {
    res.json({ success: true, data: { userId: req.user!.userId, role: req.user!.role } });
  });
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe('authenticate middleware', () => {
  it('returns 401 AUTH_MISSING_TOKEN when no Authorization header', async () => {
    const app = createApp();
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_MISSING_TOKEN);
  });

  it('returns 401 AUTH_MISSING_TOKEN when header is not Bearer', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Basic abc123');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_MISSING_TOKEN);
  });

  it('returns 401 AUTH_INVALID_TOKEN for invalid token', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid token' },
    });

    const app = createApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer invalid-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it('returns 401 AUTH_INVALID_TOKEN for expired/rejected token', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Token expired' },
    });

    const app = createApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer expired-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it('returns 401 AUTH_USER_NOT_FOUND when Supabase user has no DB record', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-orphan-id' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer valid-but-orphan');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_USER_NOT_FOUND);
  });

  it('attaches CLIENT role for a valid client token', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-client-id' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'db-client-id',
      role: 'CLIENT',
    });

    const app = createApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer valid-client-token');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('CLIENT');
    expect(res.body.data.userId).toBe('db-client-id');
  });

  it('attaches AGENT role for a valid agent token', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-agent-id' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'db-agent-id',
      role: 'AGENT',
    });

    const app = createApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer valid-agent-token');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('AGENT');
  });

  it('attaches ADMIN role for a valid admin token', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-admin-id' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'db-admin-id',
      role: 'ADMIN',
    });

    const app = createApp();
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer valid-admin-token');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('ADMIN');
  });

  it('resolves role from database, not from request body', async () => {
    // Even if the request tries to spoof a role in the body,
    // the middleware must use the DB value.
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-client-id' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'db-client-id',
      role: 'CLIENT',
    });

    const app = express();
    app.use(express.json());
    app.post('/protected', authenticate, (req: Request, res: Response) => {
      res.json({ success: true, data: { role: req.user!.role } });
    });
    app.use(errorMiddleware);

    const res = await request(app)
      .post('/protected')
      .set('Authorization', 'Bearer valid-client-token')
      .send({ role: 'ADMIN' }); // attempt to escalate

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('CLIENT'); // DB role wins
  });

  it('looks up user by authUserId, not by id', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-auth-id-123' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'db-user-id',
      role: 'AGENT',
    });

    const app = createApp();
    await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer valid-token');

    expect(mockPrismaObj.user.findUnique).toHaveBeenCalledWith({
      where: { authUserId: 'supabase-auth-id-123' },
      select: { id: true, role: true },
    });
  });
});
