/**
 * Booking routes — booking lifecycle endpoints.
 *
 * Currently supports:
 *   POST /api/v1/bookings/:id/complete        — client-controlled booking completion
 *   POST /api/v1/bookings/:id/reviews         — CLIENT → WORKER review (path-based)
 *   POST /api/v1/bookings/:id/reviews/worker  — WORKER → CLIENT review (path-based)
 */

import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { errors, ErrorCode } from '../lib/errors';
import { reviewInputSchema } from '../lib/reviewValidation';
import * as bookingService from '../services/bookingService';
import * as reviewService from '../services/reviewService';

const router = Router();

// All booking endpoints require authentication
router.use(authenticate);

/**
 * POST /api/v1/bookings/:id/complete
 *
 * Mark a booking as completed. Only the client who owns the linked
 * JobRequest may complete the booking.
 *
 * Idempotent: repeating the request after completion returns HTTP 200
 * with the existing completed booking.
 *
 * No request body is required or accepted.
 */
router.post('/:id/complete', requireRole('CLIENT'), async (req, res, next) => {
  try {
    const bookingId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await bookingService.completeBooking(bookingId, req.user!.userId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/bookings/:id/reviews
 *
 * Create a CLIENT_TO_WORKER review for a completed booking (path-based).
 * The booking ID comes from the URL path, not the request body.
 *
 * Request body:
 *   {
 *     "rating": 1-5,         // required — integer rating
 *     "comment": "..."       // optional — trimmed, max 1000 chars
 *   }
 *
 * Only the client who owns the booking may review it.
 * Only COMPLETED bookings may be reviewed.
 * Exactly one CLIENT_TO_WORKER review is allowed per booking.
 */
router.post('/:id/reviews', requireRole('CLIENT'), async (req, res, next) => {
  try {
    const bookingId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { rating, comment } = reviewInputSchema.parse(req.body);

    const result = await reviewService.createReview(
      bookingId,
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
 * POST /api/v1/bookings/:id/reviews/worker
 *
 * Create a WORKER_TO_CLIENT review for a completed booking (path-based).
 * The booking ID comes from the URL path, not the request body.
 *
 * Request body:
 *   {
 *     "rating": 1-5,         // required — integer rating
 *     "comment": "..."       // optional — trimmed, max 1000 chars
 *   }
 *
 * Only the worker assigned to the booking may review it.
 * Only COMPLETED bookings may be reviewed.
 * Exactly one WORKER_TO_CLIENT review is allowed per booking.
 */
router.post('/:id/reviews/worker', requireRole('WORKER'), async (req, res, next) => {
  try {
    const bookingId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { rating, comment } = reviewInputSchema.parse(req.body);

    const result = await reviewService.createWorkerReview(
      bookingId,
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
