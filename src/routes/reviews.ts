/**
 * Review routes — review lifecycle endpoints (Week 6).
 *
 * Currently supports:
 *   POST /api/v1/reviews        — CLIENT → WORKER review for a completed booking
 *   POST /api/v1/reviews/worker — WORKER → CLIENT review for a completed booking
 *
 * No GET, PUT, or DELETE endpoints are registered.
 */

import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { errors, ErrorCode } from '../lib/errors';
import { reviewInputSchema } from '../lib/reviewValidation';
import * as reviewService from '../services/reviewService';

const router = Router();

// All review endpoints require authentication
router.use(authenticate);

/**
 * POST /api/v1/reviews
 *
 * Create a CLIENT_TO_WORKER review for a completed booking.
 *
 * Request body:
 *   {
 *     "bookingId": "...",   // required — the booking to review
 *     "rating": 1-5,         // required — integer rating
 *     "comment": "..."       // optional — trimmed, max 1000 chars
 *   }
 *
 * The reviewer is determined exclusively from the authenticated principal.
 * No reviewer IDs, worker IDs, direction, or timestamps are accepted from the client.
 *
 * Only the client who owns the booking may review it.
 * Only COMPLETED bookings may be reviewed.
 * Exactly one CLIENT_TO_WORKER review is allowed per booking.
 */
router.post('/', requireRole('CLIENT'), async (req, res, next) => {
  try {
    // Validate bookingId is a non-empty string
    const bookingId = req.body?.bookingId;
    if (typeof bookingId !== 'string' || bookingId.trim().length === 0) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Valid bookingId is required');
    }

    // Validate rating and comment using existing review validation
    const { rating, comment } = reviewInputSchema.parse(req.body);

    // Create the review — reviewer is always the authenticated user
    const result = await reviewService.createReview(
      bookingId.trim(),
      req.user!.userId,
      rating,
      comment ?? null,
    );

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/reviews/worker
 *
 * Create a WORKER_TO_CLIENT review for a completed booking.
 *
 * Request body:
 *   {
 *     "bookingId": "...",   // required — the booking to review
 *     "rating": 1-5,         // required — integer rating
 *     "comment": "..."       // optional — trimmed, max 1000 chars
 *   }
 *
 * The reviewer is determined exclusively from the authenticated principal.
 * No reviewer IDs, client IDs, direction, or timestamps are accepted from the client.
 *
 * Only the worker assigned to the booking may review it.
 * Only COMPLETED bookings may be reviewed.
 * Exactly one WORKER_TO_CLIENT review is allowed per booking.
 */
router.post('/worker', requireRole('WORKER'), async (req, res, next) => {
  try {
    // Validate bookingId is a non-empty string
    const bookingId = req.body?.bookingId;
    if (typeof bookingId !== 'string' || bookingId.trim().length === 0) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Valid bookingId is required');
    }

    // Validate rating and comment using existing review validation
    const { rating, comment } = reviewInputSchema.parse(req.body);

    // Create the review — reviewer is always the authenticated user
    const result = await reviewService.createWorkerReview(
      bookingId.trim(),
      req.user!.userId,
      rating,
      comment ?? null,
    );

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
