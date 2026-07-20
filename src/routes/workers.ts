import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { errors, ErrorCode, sendSuccess } from '../lib/errors';
import { CreateWorkerSchema, VerifyWorkerSchema } from '../types';
import { createWorker, verifyWorker } from '../services/workerService';

const router = Router();

// All worker routes require authentication
router.use(authenticate);

/**
 * POST /api/v1/workers
 *
 * Create a new worker profile (AGENT only).
 * The worker starts in PENDING_APPROVAL status.
 */
router.post(
  '/',
  requireRole('AGENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateWorkerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid request body');
      }

      const worker = await createWorker({
        name: parsed.data.name,
        phone: parsed.data.phone,
        agentId: req.user!.userId,
      });

      return sendSuccess(res, worker, 'Worker profile created pending approval', 201);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PATCH /api/v1/workers/:id/verify
 *
 * Approve or suspend a worker (ADMIN only).
 */
router.patch(
  '/:id/verify',
  requireRole('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      const parsed = VerifyWorkerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid request body');
      }

      const worker = await verifyWorker({
        workerId: id,
        status: parsed.data.status,
        reason: parsed.data.reason,
      });

      return sendSuccess(res, worker, `Worker status updated to ${parsed.data.status}`);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
