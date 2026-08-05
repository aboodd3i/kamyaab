import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { ManualAssignSchema } from '../types';
import { manualAssign } from '../services/adminService';
import { sendSuccess, errors, ErrorCode } from '../lib/errors';

const router = Router();

// All admin endpoints require authentication + ADMIN role
router.use(authenticate, requireRole('ADMIN'));

/**
 * POST /api/v1/admin/job-requests/:id/assign
 *
 * Manually assign a worker to a job request.
 * The job must be in DRAFT, WORKER_CONTACTED, or MATCHING status.
 * Any existing PENDING invitations are expired and a new one is created.
 */
router.post(
  '/job-requests/:id/assign',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ManualAssignSchema.safeParse(req.body);
      if (!parsed.success) {
        throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid request body');
      }

      const jobRequestId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      const result = await manualAssign({
        jobRequestId,
        workerId: parsed.data.workerId,
        adminId: req.user!.userId,
      });

      sendSuccess(res, result, 'Worker assigned successfully');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
