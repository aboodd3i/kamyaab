import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { CreateWorkerBody, VerifyWorkerBody } from '../types';

const router = Router();

// Ensure all worker routes are authenticated
router.use(authenticate);

// POST /api/v1/workers - Agent only
router.post('/', async (req: Request, res: Response) => {
  if (req.user?.role !== 'AGENT') {
    return res.status(403).json({ success: false, message: 'Forbidden: Only Agents can create worker profiles' });
  }

  const { name, phone } = req.body as CreateWorkerBody;

  if (!name || !phone) {
    return res.status(400).json({ success: false, message: 'Name and phone are required' });
  }

  try {
    const worker = await prisma.workerProfile.create({
      data: {
        name,
        phone,
        status: 'PENDING_APPROVAL',
        agentId: req.user.id,
      },
    });

    return res.status(201).json({ success: true, data: worker, message: 'Worker profile created pending approval' });
  } catch (error: any) {
    console.error('Error creating worker:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PATCH /api/v1/workers/:id/verify - Admin only
router.patch('/:id/verify', async (req: Request, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Forbidden: Only Admins can verify workers' });
  }

  const { id } = req.params;
  const { status } = req.body as VerifyWorkerBody;

  if (!status || !['APPROVED', 'SUSPENDED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Valid status (APPROVED, SUSPENDED) is required' });
  }

  try {
    const worker = await prisma.workerProfile.update({
      where: { id },
      data: { status },
    });

    return res.json({ success: true, data: worker, message: `Worker profile status updated to ${status}` });
  } catch (error: any) {
    console.error('Error verifying worker:', error);
    // Prisma usually throws P2025 if record not found
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
