/**
 * Shared test utilities for mocking infrastructure.
 *
 * Provides a consistent mock environment so individual test files
 * don't need to repeat the same vi.mock() boilerplate.
 */

import { vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../errors';
import type { AuthPrincipal } from '../../types/auth';

/** Mock env config so no real env vars are needed during tests. */
export function mockEnv() {
  vi.mock('../config/env', () => ({
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
}

/**
 * Mock the auth middleware so tests can inject a role.
 * `authenticate` is a no-op; `requireRole` uses real logic.
 */
export function mockAuth() {
  vi.mock('../middleware/auth', () => ({
    authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
    requireRole: (...roles: string[]) =>
      (req: Request, _res: Response, next: NextFunction) => {
        if (!req.user || !roles.includes(req.user.role)) {
          return next(new AppError(403, ErrorCode.AUTH_FORBIDDEN, 'Insufficient permissions'));
        }
        next();
      },
  }));
}

/** Mock prisma to avoid DB access. Returns the mock object for per-test setup. */
export function mockPrisma() {
  const mockPrismaObj = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    clientProfile: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    workerProfile: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    category: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    area: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  };
  vi.mock('../lib/prisma', () => ({ default: mockPrismaObj }));
  return mockPrismaObj;
}

/** Mock supabase client. Returns the mock object for per-test setup. */
export function mockSupabase() {
  const mockSupabaseObj = {
    auth: {
      getUser: vi.fn(),
      signInWithPassword: vi.fn(),
      signInWithOtp: vi.fn(),
      verifyOtp: vi.fn(),
    },
  };
  vi.mock('../lib/supabase', () => ({ supabase: mockSupabaseObj }));
  return mockSupabaseObj;
}

/** Build a mock AuthPrincipal for a given role. */
export function mockPrincipal(role: AuthPrincipal['role']): AuthPrincipal {
  return {
    userId: `mock-${role.toLowerCase()}-id`,
    authUserId: `mock-${role.toLowerCase()}-auth-id`,
    role,
  };
}
