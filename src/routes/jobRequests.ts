import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import {
  CreateJobRequestSchema,
  UpdateJobRequestSchema,
  SubmitJobRequestSchema,
} from '../types';
import * as jobRequestService from '../services/jobRequestService';

const router = Router();

// All routes require client role for now (Flow A is client-driven)
router.use(authenticate);
router.use(requireRole('CLIENT'));

/** POST /api/v1/job-requests - Create a draft */
router.post('/', async (req, res, next) => {
  try {
    const input = CreateJobRequestSchema.parse(req.body);
    const draft = await jobRequestService.createDraft(req.user!.userId, input);
    res.status(201).json({ success: true, data: draft });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/job-requests/mine - Get my jobs */
router.get('/mine', async (req, res, next) => {
  try {
    const jobs = await jobRequestService.getMyJobs(req.user!.userId);
    res.json({ success: true, data: jobs });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/job-requests/:id - Update draft */
router.patch('/:id', async (req, res, next) => {
  try {
    const input = UpdateJobRequestSchema.parse(req.body);
    const updated = await jobRequestService.updateDraft(req.params.id, req.user!.userId, input);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/job-requests/:id/submit - Submit and send invitation */
router.post('/:id/submit', async (req, res, next) => {
  try {
    const input = SubmitJobRequestSchema.parse(req.body);
    const submitted = await jobRequestService.submitJobRequest(req.params.id, req.user!.userId, input);
    res.json({ success: true, data: submitted });
  } catch (err) {
    next(err);
  }
});

export default router;
