/**
 * Unit tests for the rate limiting middleware (Week 7).
 *
 * Tests:
 *   1. Login rate limiter allows requests under the limit
 *   2. Login rate limiter blocks requests over the limit (429 + RATE_LIMITED)
 *   3. Login rate limiter includes Retry-After header
 *   4. API rate limiter allows requests under the limit
 *   5. API rate limiter blocks requests over the limit (429 + RATE_LIMITED)
 *   6. API rate limiter includes Retry-After header
 *   7. Rate limiter response body uses the standard error envelope
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';

// ─── Mock env BEFORE any imports that pull in env.ts ───────────────────────

vi.mock('../../config/env', () => ({
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
  createLoginRateLimiter,
  createApiRateLimiter,
  LOGIN_MAX,
  LOGIN_WINDOW_MS,
  API_MAX,
  API_WINDOW_MS,
} from '../rateLimiter';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createAppWithLimiter(limiter: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(limiter);
  app.get('/test', (_req: Request, res: Response) => {
    res.json({ success: true, message: 'ok' });
  });
  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Rate Limiter Middleware', () => {
  beforeEach(() => {
    // Reset modules to get fresh MemoryStore instances
    vi.resetModules();
  });

  // ── Login rate limiter ───────────────────────────────────────────────

  it('1. login rate limiter allows requests under the limit', async () => {
    const app = createAppWithLimiter(createLoginRateLimiter());

    // Send LOGIN_MAX requests — all should succeed
    for (let i = 0; i < LOGIN_MAX; i++) {
      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    }
  });

  it('2. login rate limiter blocks requests over the limit (429)', async () => {
    const app = createAppWithLimiter(createLoginRateLimiter());

    // Exhaust the limit
    for (let i = 0; i < LOGIN_MAX; i++) {
      await request(app).get('/test');
    }

    // Next request should be rate limited
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('3. login rate limiter includes Retry-After header', async () => {
    const app = createAppWithLimiter(createLoginRateLimiter());

    for (let i = 0; i < LOGIN_MAX; i++) {
      await request(app).get('/test');
    }

    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    // Retry-After should be approximately LOGIN_WINDOW_MS / 1000 seconds
    const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
    expect(retryAfter).toBe(Math.ceil(LOGIN_WINDOW_MS / 1000));
  });

  // ── API rate limiter ─────────────────────────────────────────────────

  it('4. API rate limiter allows requests under the limit', async () => {
    const app = createAppWithLimiter(createApiRateLimiter());

    // Send a few requests — all should succeed
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    }
  });

  it('5. API rate limiter blocks requests over the limit (429)', async () => {
    // Use a small max for testing — create a custom limiter with low max
    const app = express();
    app.use(express.json());

    // Import rate-limit directly to create a low-max limiter
    const rateLimit = (await import('express-rate-limit')).default;
    const { MemoryStore } = await import('express-rate-limit');
    const { ErrorCode, sendError } = await import('../../lib/errors');

    const lowMaxLimiter = rateLimit({
      store: new MemoryStore(),
      windowMs: 60 * 1000,
      max: 3,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) => req.ip ?? 'unknown',
      handler: (_req: Request, res: Response) => {
        res.setHeader('Retry-After', 60);
        sendError(res, 429, ErrorCode.RATE_LIMITED, 'Too many requests');
      },
    });

    app.use(lowMaxLimiter);
    app.get('/test', (_req: Request, res: Response) => {
      res.json({ success: true });
    });

    // 3 requests should pass
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    }

    // 4th should be blocked
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('6. API rate limiter includes Retry-After header', async () => {
    const app = createAppWithLimiter(createApiRateLimiter());

    // Exhaust the limit
    for (let i = 0; i < API_MAX; i++) {
      await request(app).get('/test');
    }

    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
    expect(retryAfter).toBe(Math.ceil(API_WINDOW_MS / 1000));
  });

  it('7. rate limiter response body uses the standard error envelope', async () => {
    const app = createAppWithLimiter(createLoginRateLimiter());

    for (let i = 0; i < LOGIN_MAX; i++) {
      await request(app).get('/test');
    }

    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringContaining('Too many'),
      },
    });
  });
});
