/**
 * Rate limiting middleware (Week 7).
 *
 * Two limiters:
 *
 *   1. createLoginRateLimiter() — protects staff login (and any future
 *      OTP verification endpoints) from brute-force attacks.
 *      Limits to LOGIN_MAX per IP per LOGIN_WINDOW_MS.
 *      Keys on IP address (no user identity at login time).
 *
 *   2. createApiRateLimiter()  — general API throttle applied to all
 *      authenticated routes.  Limits to API_MAX per IP per API_WINDOW_MS.
 *      Keys on IP address.
 *
 * Storage: in-memory (express-rate-limit MemoryStore).
 *
 * ⚠️  LIMITATION: An in-memory store is per-process.  When multiple
 * backend replicas are introduced, this must be replaced with a
 * shared store such as Redis (e.g. rate-limit-redis).
 */

import { Request, Response } from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { ErrorCode, sendError } from '../lib/errors';

// ─── Configuration constants ───────────────────────────────────────────────

/** Time window for login attempts: 15 minutes. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Maximum login attempts per IP per window. */
export const LOGIN_MAX = 10;

/** Time window for general API requests: 1 minute. */
export const API_WINDOW_MS = 60 * 1000;

/** Maximum API requests per IP per minute. */
export const API_MAX = 100;

// ─── IP key generator ──────────────────────────────────────────────────────

/**
 * Extract the client IP address from the request.
 *
 * Trusts X-Forwarded-For when present (common behind proxies/load
 * balancers in staging/production).  Falls back to req.ip.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    // X-Forwarded-For can be a comma-separated list; take the first (client)
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  return req.ip ?? 'unknown';
}

// ─── Login rate limiter ────────────────────────────────────────────────────

/**
 * Create the login rate-limit middleware.
 *
 * Each call creates a fresh MemoryStore.  In production this factory
 * is called once when the route is registered.
 *
 * Keys on IP address — at login time there is no authenticated user.
 * On limit exceeded, returns the standard error envelope with code
 * RATE_LIMITED and HTTP 429, plus a Retry-After header.
 */
export function createLoginRateLimiter() {
  const store = new MemoryStore();

  return rateLimit({
    store,
    windowMs: LOGIN_WINDOW_MS,
    max: LOGIN_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => getClientIp(req),
    handler: (_req: Request, res: Response): void => {
      res.setHeader('Retry-After', Math.ceil(LOGIN_WINDOW_MS / 1000));
      sendError(
        res,
        429,
        ErrorCode.RATE_LIMITED,
        'Too many login attempts from this IP. Please try again later.',
      );
    },
  });
}

// ─── API rate limiter ──────────────────────────────────────────────────────

/**
 * Create the general API rate-limit middleware.
 *
 * Applied to all authenticated API routes as a safety net against
 * abuse and accidental flooding.  Keys on IP address.
 *
 * On limit exceeded, returns the standard error envelope with code
 * RATE_LIMITED and HTTP 429, plus a Retry-After header.
 */
export function createApiRateLimiter() {
  const store = new MemoryStore();

  return rateLimit({
    store,
    windowMs: API_WINDOW_MS,
    max: API_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => getClientIp(req),
    handler: (_req: Request, res: Response): void => {
      res.setHeader('Retry-After', Math.ceil(API_WINDOW_MS / 1000));
      sendError(
        res,
        429,
        ErrorCode.RATE_LIMITED,
        'Too many requests from this IP. Please slow down.',
      );
    },
  });
}
