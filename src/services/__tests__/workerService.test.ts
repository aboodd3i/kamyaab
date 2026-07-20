/**
 * Worker service tests — duplicate phone race condition.
 *
 * Tests the real `createWorker` service function with a mocked Prisma
 * client. Verifies that:
 *
 * 1. Pre-check detects existing phone → 409 WORKER_DUPLICATE_PHONE
 * 2. P2002 during insert (race condition) → 409 WORKER_PHONE_ALREADY_EXISTS
 * 3. Response does not expose Prisma internals
 * 4. Non-P2002 database errors propagate as-is (500 path)
 * 5. P2002 targeting a different field is NOT mapped to phone conflict
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrismaObj }));

import { createWorker } from '../workerService';
import { AppError, ErrorCode } from '../../lib/errors';

// --- Helpers ----------------------------------------------------------------

/** Build a realistic Prisma P2002 error object. */
function prismaP2002(target: string[]): Error {
  const err = new Error('Unique constraint failed on the fields: (`' + target.join('`,`') + '`)');
  (err as any).code = 'P2002';
  (err as any).meta = { target };
  return err;
}

/** Build a generic non-P2002 Prisma error. */
function prismaP2003(): Error {
  const err = new Error('Foreign key constraint failed');
  (err as any).code = 'P2003';
  return err;
}

const mockCreatedWorker = {
  id: 'worker-1',
  name: 'Test Worker',
  phone: '+923001234567',
  status: 'PENDING_APPROVAL',
  suspensionReason: null,
  agentId: 'agent-1',
  createdAt: new Date('2026-07-20T00:00:00.000Z'),
  updatedAt: new Date('2026-07-20T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe('createWorker — duplicate phone pre-check', () => {
  it('returns 409 WORKER_DUPLICATE_PHONE when phone exists before insert', async () => {
    // findUnique returns an existing record
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue({ id: 'existing-worker' });

    await expect(
      createWorker({ name: 'Worker', phone: '+923001234567', agentId: 'agent-1' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.WORKER_DUPLICATE_PHONE,
    });

    // create should never be called
    expect(mockPrismaObj.workerProfile.create).not.toHaveBeenCalled();
  });
});

describe('createWorker — P2002 race condition', () => {
  it('returns 409 WORKER_PHONE_ALREADY_EXISTS when P2002 targets phone', async () => {
    // Pre-check passes (no existing record)
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(null);
    // But create throws P2002 (concurrent insert won the race)
    mockPrismaObj.workerProfile.create.mockRejectedValue(prismaP2002(['phone']));

    await expect(
      createWorker({ name: 'Worker', phone: '+923001234567', agentId: 'agent-1' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.WORKER_PHONE_ALREADY_EXISTS,
      message: 'A worker with this phone number already exists',
    });
  });

  it('does not expose Prisma internals in the error', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(null);
    mockPrismaObj.workerProfile.create.mockRejectedValue(prismaP2002(['phone']));

    try {
      await createWorker({ name: 'Worker', phone: '+923001234567', agentId: 'agent-1' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      // The message must be our safe message, not the Prisma message
      expect(appErr.message).toBe('A worker with this phone number already exists');
      // Must not contain constraint names or Prisma codes
      expect(appErr.message).not.toContain('P2002');
      expect(appErr.message).not.toContain('constraint');
      // The error code must be our stable code
      expect(appErr.code).toBe(ErrorCode.WORKER_PHONE_ALREADY_EXISTS);
    }
  });

  it('does not treat P2002 on a different field as a phone conflict', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(null);
    // P2002 targeting userId, not phone
    mockPrismaObj.workerProfile.create.mockRejectedValue(prismaP2002(['userId']));

    try {
      await createWorker({ name: 'Worker', phone: '+923001234567', agentId: 'agent-1' });
      expect.fail('Should have thrown');
    } catch (err) {
      // Should NOT be mapped to WORKER_PHONE_ALREADY_EXISTS
      expect(err).not.toBeInstanceOf(AppError);
      // The raw Prisma error should propagate (will be handled by error middleware as 500)
      expect((err as any).code).toBe('P2002');
    }
  });

  it('lets non-P2002 database errors propagate to the generic error path', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(null);
    mockPrismaObj.workerProfile.create.mockRejectedValue(prismaP2003());

    try {
      await createWorker({ name: 'Worker', phone: '+923001234567', agentId: 'agent-1' });
      expect.fail('Should have thrown');
    } catch (err) {
      // Should NOT be an AppError — let the middleware handle it as 500
      expect(err).not.toBeInstanceOf(AppError);
      expect((err as any).code).toBe('P2003');
    }
  });

  it('lets generic (non-Prisma) errors propagate', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(null);
    const genericError = new Error('Connection refused');
    mockPrismaObj.workerProfile.create.mockRejectedValue(genericError);

    await expect(
      createWorker({ name: 'Worker', phone: '+923001234567', agentId: 'agent-1' }),
    ).rejects.toBe(genericError);
  });
});

describe('createWorker — successful creation', () => {
  it('creates a worker and returns a safe DTO', async () => {
    mockPrismaObj.workerProfile.findUnique.mockResolvedValue(null);
    mockPrismaObj.workerProfile.create.mockResolvedValue(mockCreatedWorker);

    const result = await createWorker({
      name: 'Test Worker',
      phone: '+923001234567',
      agentId: 'agent-1',
    });

    expect(result.id).toBe('worker-1');
    expect(result.phone).toBe('+923001234567');
    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.createdAt).toBe('2026-07-20T00:00:00.000Z');
  });
});
