/**
 * GET /api/v1/me route tests.
 *
 * Tests the real /me route with mocked Supabase and Prisma.
 * Verifies:
 *
 * - Valid client token returns identity
 * - Client bootstrap is idempotent (first call creates, second returns existing)
 * - Missing token → 401
 * - Invalid token → 401
 * - Suspended agent is rejected
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

const { mockPrismaObj, mockSupabaseObj } = vi.hoisted(() => ({
  mockPrismaObj: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    clientProfile: {
      create: vi.fn(),
    },
    workerProfile: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockSupabaseObj: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrismaObj }));
vi.mock('../../lib/supabase', () => ({ supabase: mockSupabaseObj }));

import meRoutes from '../me';
import { errorMiddleware, ErrorCode } from '../../lib/errors';

// --- Helpers ----------------------------------------------------------------

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/me', meRoutes);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe('GET /api/v1/me', () => {
  it('returns 401 when no token is provided', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_MISSING_TOKEN);
  });

  it('returns 401 for invalid token', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid' },
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer bad-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it('returns existing user identity without creating a new record', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'supabase-id', phone: '+923001234567' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'db-user-id',
      authUserId: 'supabase-id',
      role: 'CLIENT',
      phone: '+923001234567',
      email: null,
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.userId).toBe('db-user-id');
    expect(res.body.data.authUserId).toBe('supabase-id');
    expect(res.body.data.role).toBe('CLIENT');
    expect(mockPrismaObj.user.create).not.toHaveBeenCalled();
  });

  it('bootstraps a new client on first call (idempotent create)', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'new-supabase-id', phone: '+923001234567', email: null } },
      error: null,
    });

    // First findUnique returns null (user doesn't exist yet)
    mockPrismaObj.user.findUnique.mockResolvedValue(null);

    // Transaction creates user + profile
    mockPrismaObj.$transaction.mockImplementation(async (cb: any) => {
      const tx = {
        user: {
          create: vi.fn().mockResolvedValue({
            id: 'new-db-id',
            authUserId: 'new-supabase-id',
            role: 'CLIENT',
            phone: '+923001234567',
            email: null,
          }),
        },
        clientProfile: {
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return cb(tx);
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer new-client-token');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('CLIENT');
    expect(res.body.data.userId).toBe('new-db-id');
    expect(mockPrismaObj.$transaction).toHaveBeenCalledOnce();
  });

  it('is idempotent — second call returns existing record without creating', async () => {
    // Simulate second call: user already exists from bootstrap
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'new-supabase-id', phone: '+923001234567' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'new-db-id',
      authUserId: 'new-supabase-id',
      role: 'CLIENT',
      phone: '+923001234567',
      email: null,
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer new-client-token');

    expect(res.status).toBe(200);
    expect(mockPrismaObj.$transaction).not.toHaveBeenCalled();
    expect(mockPrismaObj.user.create).not.toHaveBeenCalled();
  });

  it('rejects suspended agent accounts', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'agent-supabase-id' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'agent-db-id',
      authUserId: 'agent-supabase-id',
      role: 'AGENT',
      phone: null,
      email: 'agent@kamyaab.pk',
    });
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue({
      status: 'SUSPENDED',
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer agent-token');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ErrorCode.AUTH_ACCOUNT_SUSPENDED);
  });

  it('allows approved agent accounts', async () => {
    mockSupabaseObj.auth.getUser.mockResolvedValue({
      data: { user: { id: 'agent-supabase-id' } },
      error: null,
    });
    mockPrismaObj.user.findUnique.mockResolvedValue({
      id: 'agent-db-id',
      authUserId: 'agent-supabase-id',
      role: 'AGENT',
      phone: null,
      email: 'agent@kamyaab.pk',
    });
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue({
      status: 'APPROVED',
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer agent-token');

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('AGENT');
  });
});
