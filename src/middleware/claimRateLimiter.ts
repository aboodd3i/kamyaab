/**
 * Rate limiter for the worker profile claim endpoint.
 *
 * Limits FAILED claim attempts to CLAIM_MAX_FAILED_ATTEMPTS per
 * authenticated user per CLAIM_WINDOW_MS time window.  Successful
 * and idempotently successful claims do not consume the allowance.
 *
 * The limiter keys on the authenticated local user ID (req.user.userId),
 * never on phone, CNIC, or any request-body field.
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

/** Time window for counting failed attempts: 15 minutes. */
export const CLAIM_WINDOW_MS = 15 * 60 * 1000;

/** Maximum failed claim attempts per user per window. */
export const CLAIM_MAX_FAILED_ATTEMPTS = 5;

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create the claim rate-limit middleware.
 *
 * Each call creates a fresh MemoryStore.  In production this factory
 * is called once when the route is registered, so a single store
 * is shared across all requests to that route.  In tests, each
 * test app gets its own store for isolation.
 *
 * Uses express-rate-limit with:
 *   - skipSuccessfulRequests: true  → only failed responses (non-2xx)
 *     are counted against the limit.
 *   - keyGenerator: req.user.userId  → keys on authenticated identity.
 *   - standardHeaders: true          → RateLimit-* headers on responses.
 *   - legacyHeaders: false           → no X-RateLimit-* headers.
 *
 * On limit exceeded, returns the repository's standard error envelope
 * with code WORKER_CLAIM_RATE_LIMITED and HTTP 429.
 */
export function createClaimRateLimiter() {
  const store = new MemoryStore();

  return rateLimit({
    store,
    windowMs: CLAIM_WINDOW_MS,
    max: CLAIM_MAX_FAILED_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    // Only count failed attempts (non-2xx responses).
    // Successful claims (200) and idempotent successes (200) are skipped.
    skipSuccessfulRequests: true,
    // Key on authenticated user ID — never on body fields.
    keyGenerator: (req: Request): string => {
      const userId = req.user?.userId;
      if (!userId) {
        // Fallback to authUserId if userId is somehow missing.
        // If neither exists, use a sentinel that won't collide with real IDs.
        return req.user?.authUserId ?? 'unauthenticated';
      }
      return userId;
    },
    // Custom handler for when limit is exceeded.
    handler: (_req: Request, res: Response): void => {
      res.setHeader('Retry-After', Math.ceil(CLAIM_WINDOW_MS / 1000));
      sendError(
        res,
        429,
        ErrorCode.WORKER_CLAIM_RATE_LIMITED,
        'Too many failed claim attempts. Please try again later.',
      );
    },
    // Skip rate limiting for unauthenticated requests —
    // the authenticate middleware will reject them first.
    skip: (req: Request): boolean => {
      return !req.user;
    },
  });
}

/**
 * Reset the rate-limit store.  For test isolation only.
 *
 * Since each call to createClaimRateLimiter() creates a fresh store,
 * this is a no-op kept for API compatibility with tests that import it.
 * Tests achieve isolation by creating a new app (and thus a new limiter
 * with a new store) for each test case.
 */
export function resetClaimRateLimitStore(): void {
  // No-op: each createClaimRateLimiter() call already creates a fresh store.
}
