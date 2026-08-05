/**
 * Complaint routes — complaint lifecycle endpoints (Week 6).
 *
 * Supports:
 *   POST   /api/v1/complaints          — file a complaint (any authenticated user)
 *   GET    /api/v1/complaints/:id       — get a complaint by ID (any authenticated user)
 *   GET    /api/v1/complaints           — list complaints (admin only)
 *   POST   /api/v1/complaints/:id/resolve — resolve or dismiss a complaint (admin only)
 */

import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { errors, ErrorCode } from '../lib/errors';
import { createComplaintSchema, resolveComplaintSchema } from '../lib/complaintValidation';
import * as complaintService from '../services/complaintService';

const router = Router();

// All complaint endpoints require authentication
router.use(authenticate);

/**
 * POST /api/v1/complaints
 *
 * File a complaint against a booking.
 *
 * Request body:
 *   {
 *     "bookingId": "...",  // required — the booking to complain about
 *     "reason": "..."       // required — trimmed, max 2000 chars
 *   }
 *
 * Any authenticated user may file a complaint.
 */
router.post('/', async (req, res, next) => {
  try {
    const { bookingId, reason } = req.body ?? {};

    if (typeof bookingId !== 'string' || bookingId.trim().length === 0) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Valid bookingId is required');
    }

    const parsed = createComplaintSchema.parse({ reason });

    const result = await complaintService.createComplaint(
      bookingId.trim(),
      req.user!.userId,
      parsed.reason,
    );

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/complaints/:id
 *
 * Get a single complaint by ID.
 * Any authenticated user may view a complaint.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const complaintId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await complaintService.findComplaint(complaintId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/complaints
 *
 * List complaints, optionally filtered by status.
 * Admin only.
 *
 * Query params:
 *   status — 'OPEN' | 'RESOLVED' | 'DISMISSED' (optional)
 *   limit  — max results (optional, default 50, max 100)
 */
router.get('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const result = await complaintService.listComplaints(
      status as complaintService.ComplaintStatus | undefined,
      limit,
    );

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/complaints/:id/resolve
 *
 * Resolve or dismiss a complaint.
 * Admin only.
 *
 * Request body:
 *   {
 *     "status": "RESOLVED" | "DISMISSED",  // required
 *     "resolution": "..."                    // optional — trimmed, max 2000 chars
 *   }
 */
router.post('/:id/resolve', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const complaintId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const parsed = resolveComplaintSchema.parse(req.body);

    const result = await complaintService.resolveComplaint(
      complaintId,
      req.user!.userId,
      parsed.status,
      parsed.resolution ?? null,
    );

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
