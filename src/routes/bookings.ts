/**
 * Booking routes — booking lifecycle endpoints.
 *
 * Currently supports:
 *   POST /api/v1/bookings/:id/complete — client-controlled booking completion
 */

import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import * as bookingService from '../services/bookingService';

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

export default router;
