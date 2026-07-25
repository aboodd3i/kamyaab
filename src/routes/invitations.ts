import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { InvitationResponseSchema } from '../types';
import * as invitationService from '../services/invitationService';
import prisma from '../lib/prisma';

const router = Router();

// Worker responds to invitations
router.use(authenticate);

/** GET /api/v1/invitations/pending - List pending invitations for the worker */
router.get('/pending', requireRole('AGENT', 'CLIENT'), async (req, res, next) => {
  try {
    const worker = await prisma.workerProfile.findUnique({
      where: { userId: req.user!.userId },
    });
    
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker profile not found for this user' });
    }

    const pending = await invitationService.getPendingInvitations(worker.id);
    res.json({ success: true, data: pending });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/invitations/:id/respond - Accept or reject */
router.post('/:id/respond', async (req, res, next) => {
  try {
    const input = InvitationResponseSchema.parse(req.body);
    
    // Fetch the worker ID for the current user
    const worker = await prisma.workerProfile.findUnique({
      where: { userId: req.user!.userId },
    });
    
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker profile not found for this user' });
    }

    const result = await invitationService.respondToInvitation(req.params.id, worker.id, input);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
