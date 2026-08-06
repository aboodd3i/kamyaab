import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { InvitationResponseSchema } from '../types';
import * as invitationService from '../services/invitationService';
import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';

const router = Router();

// All invitation endpoints require authentication
router.use(authenticate);

/**
 * GET /api/v1/invitations/pending - List pending invitations for the worker.
 *
 * A claimed worker (role WORKER) can view their pending invitations.
 * The worker profile is resolved through the authenticated user's userId,
 * which is set during the claim flow (POST /api/v1/workers/claim).
 */
router.get('/pending', requireRole('WORKER'), async (req, res, next) => {
  try {
    const worker = await prisma.workerProfile.findUnique({
      where: { userId: req.user!.userId },
    });

    if (!worker) {
      return next(errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker profile not found for this user'));
    }

    const pending = await invitationService.getPendingInvitations(worker.id);
    res.json({ success: true, data: pending });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/invitations/:id/respond - Accept or reject an invitation.
 *
 * Only a claimed worker (role WORKER) can respond to invitations.
 * The worker profile is resolved through the authenticated user's userId,
 * ensuring that only the worker who claimed the profile can act on it.
 */
router.post('/:id/respond', requireRole('WORKER'), async (req, res, next) => {
  try {
    const input = InvitationResponseSchema.parse(req.body);
    const invitationId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // Fetch the worker profile linked to the authenticated user
    const worker = await prisma.workerProfile.findUnique({
      where: { userId: req.user!.userId },
    });

    if (!worker) {
      return next(errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker profile not found for this user'));
    }

    const result = await invitationService.respondToInvitation(invitationId, worker.id, input, req.user?.userId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
