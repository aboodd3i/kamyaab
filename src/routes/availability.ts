import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { SetAvailabilitySchema } from '../types';
import { setAvailability, getAvailability } from '../services/availabilityService';
import prisma from '../lib/prisma';
import { errors, ErrorCode, sendSuccess } from '../lib/errors';

const router = Router();

// All availability endpoints require authentication
router.use(authenticate);

/**
 * GET /api/v1/availability
 *
 * Returns the authenticated worker's current availability status.
 * The worker profile is resolved through the authenticated user's userId.
 */
router.get('/', requireRole('CLIENT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const worker = await prisma.workerProfile.findUnique({
      where: { userId: req.user!.userId },
      select: { id: true },
    });

    if (!worker) {
      return next(errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker profile not found for this user'));
    }

    const result = await getAvailability(worker.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/availability
 *
 * Sets the authenticated worker's availability status.
 * Workers can set: AVAILABLE, BUSY, UNAVAILABLE.
 * The updateSource is always WORKER_PORTAL for self-service updates.
 */
router.put('/', requireRole('CLIENT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = SetAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid request body');
    }

    const worker = await prisma.workerProfile.findUnique({
      where: { userId: req.user!.userId },
      select: { id: true },
    });

    if (!worker) {
      return next(errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker profile not found for this user'));
    }

    const result = await setAvailability({
      workerId: worker.id,
      status: parsed.data.status,
      updateSource: 'WORKER_PORTAL',
      busyUntil: parsed.data.busyUntil ?? null,
    });

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

export default router;
