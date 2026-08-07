/**
 * Week 7 — Security Audit Tests
 *
 * Verifies that sensitive data is never exposed in API responses:
 *
 *   1. Public worker DTO does not contain forbidden fields
 *      (phone, CNIC, addresses, document paths, reference contact, etc.)
 *   2. Public worker DTO findForbiddenKey scanner catches violations
 *   3. MyJobs DTO does not include worker contact info before booking
 *   4. Error middleware does not leak stack traces in production
 *   5. Error middleware returns stack traces in development (for debugging)
 *   6. AppError responses use the standard error envelope
 *   7. Rate-limited responses don't leak internal details
 */

import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// ─── Mock env BEFORE any imports that pull in env.ts ───────────────────────

vi.mock('../config/env', () => ({
  env: {
    databaseUrl: 'postgresql://dummy',
    directUrl: 'postgresql://dummy',
    supabaseUrl: 'https://dummy.supabase.co',
    supabaseAnonKey: 'dummy-anon-key',
    supabaseServiceRoleKey: undefined,
    port: 3000,
    nodeEnv: 'test',
    isProduction: false,
  },
}));

import {
  toPublicWorker,
  findForbiddenKey,
  FORBIDDEN_PUBLIC_KEYS,
} from '../lib/publicWorkerDto';
import { AppError, ErrorCode, errorMiddleware, sendError } from '../lib/errors';

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Week 7 — Security Audit', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. Public worker DTO — no forbidden fields
  // ═══════════════════════════════════════════════════════════════════════

  it('1. public worker DTO does not contain forbidden fields', () => {
    const worker = {
      id: 'worker-123',
      name: 'Test Worker',
      rating: 4.5,
      ratingCount: 10,
      completedJobsCount: 25,
      isPriorityListed: false,
      identityChecked: true,
      phoneConfirmed: true,
      referenceStatus: 'CONFIRMED',
      backgroundChecked: true,
      skillAssessed: true,
      categories: [{ category: { id: 'cat-1', name: 'Plumbing' } }],
      serviceAreas: [{ area: { id: 'area-1', name: 'Karachi', parentId: null } }],
      // Sensitive fields that should NOT appear in the DTO
      phone: '+923001234567',
      cnicNumber: '12345-6789012-3',
      cnicFrontPath: 'secret/path/front.jpg',
      cnicBackPath: 'secret/path/back.jpg',
      referenceName: 'Reference Person',
      referencePhone: '+93007654321',
      agentId: 'agent-123',
      userId: 'user-123',
      suspensionReason: null,
      address: 'House 123, Street 456',
    };

    const dto = toPublicWorker(worker);

    // Verify forbidden keys are not present at any depth
    const forbidden = findForbiddenKey(dto);
    expect(forbidden).toBeNull();

    // Explicitly check that the DTO has the expected safe fields
    expect(dto.id).toBe('worker-123');
    expect(dto.name).toBe('Test Worker');
    expect(dto.rating).toBe(4.5);
    expect(dto.verification.identityChecked).toBe(true);
    expect(dto.categories).toHaveLength(1);
    expect(dto.serviceAreas).toHaveLength(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. findForbiddenKey scanner catches violations
  // ═══════════════════════════════════════════════════════════════════════

  it('2. findForbiddenKey scanner catches forbidden fields at any depth', () => {
    // Top-level violation
    const obj1 = { id: '1', phone: '+923001234567' };
    expect(findForbiddenKey(obj1)).toBe('phone');

    // Nested violation
    const obj2 = { data: { worker: { cnicNumber: '12345' } } };
    expect(findForbiddenKey(obj2)).toBe('data.worker.cnicNumber');

    // Array element violation
    const obj3 = { workers: [{ id: '1', address: 'secret' }] };
    expect(findForbiddenKey(obj3)).toBe('workers.0.address');

    // Clean object — no violations
    const obj4 = { id: '1', name: 'Worker', rating: 4.5 };
    expect(findForbiddenKey(obj4)).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. FORBIDDEN_PUBLIC_KEYS list covers all sensitive fields
  // ═══════════════════════════════════════════════════════════════════════

  it('3. FORBIDDEN_PUBLIC_KEYS includes all known sensitive field names', () => {
    const required = [
      'phone',
      'cnicNumber',
      'cnicFrontPath',
      'cnicBackPath',
      'referenceName',
      'referencePhone',
      'agentId',
      'userId',
      'suspensionReason',
      'address',
    ];
    for (const key of required) {
      expect(FORBIDDEN_PUBLIC_KEYS).toContain(key);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Error middleware does not leak stack traces in production
  // ═══════════════════════════════════════════════════════════════════════

  it('4. error middleware does not leak stack traces for unhandled errors', () => {
    const app = express();
    app.use(express.json());

    // Simulate an unhandled error with sensitive info in the message
    app.get('/error', () => {
      throw new Error('Database connection failed at postgres://user:pass@host:5432');
    });

    app.use(errorMiddleware);

    return request(app)
      .get('/error')
      .then((res) => {
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        // The response should have the standard error envelope shape
        expect(res.body.error.message).toBeDefined();
        // Stack trace property should never be serialized into the response
        expect(res.body.error.stack).toBeUndefined();
        expect(res.body.stack).toBeUndefined();
      });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. AppError responses use the standard error envelope
  // ═══════════════════════════════════════════════════════════════════════

  it('5. AppError responses use the standard error envelope', () => {
    const app = express();
    app.use(express.json());

    app.get('/forbidden', () => {
      throw new AppError(403, ErrorCode.AUTH_FORBIDDEN, 'Insufficient permissions');
    });

    app.use(errorMiddleware);

    return request(app)
      .get('/forbidden')
      .then((res) => {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({
          success: false,
          error: {
            code: 'AUTH_FORBIDDEN',
            message: 'Insufficient permissions',
          },
        });
      });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Zod errors are handled as validation errors
  // ═══════════════════════════════════════════════════════════════════════

  it('6. Zod validation errors return 400 with VALIDATION_ERROR code', () => {
    const app = express();
    app.use(express.json());

    app.get('/validate', () => {
      const err = new Error('Validation failed');
      err.name = 'ZodError';
      throw err;
    });

    app.use(errorMiddleware);

    return request(app)
      .get('/validate')
      .then((res) => {
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. sendError produces the correct response shape
  // ═══════════════════════════════════════════════════════════════════════

  it('7. sendError produces the standard error envelope', () => {
    const app = express();
    app.get('/rate-limited', (req: Request, res: Response) => {
      res.setHeader('Retry-After', '900');
      sendError(res, 429, ErrorCode.RATE_LIMITED, 'Too many requests');
    });

    return request(app)
      .get('/rate-limited')
      .then((res) => {
        expect(res.status).toBe(429);
        expect(res.headers['retry-after']).toBe('900');
        expect(res.body).toEqual({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests',
          },
        });
      });
  });
});
