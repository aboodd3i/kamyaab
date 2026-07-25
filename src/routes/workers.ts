import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { errors, ErrorCode, sendSuccess } from '../lib/errors';
import { CreateWorkerSchema, VerifyWorkerSchema } from '../types';
import { createWorker, verifyWorker } from '../services/workerService';
import { updateWorker, uploadCnicDocuments, MAX_CNIC_FILE_SIZE, ACCEPTED_MIME_TYPES } from '../services/workerServiceWeek3';
import { createSupabaseStorageAdapter } from '../services/supabaseStorageAdapter';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env';

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
        cnicNumber: parsed.data.cnicNumber,
        referenceName: parsed.data.referenceName,
        referencePhone: parsed.data.referencePhone,
        identityChecked: parsed.data.identityChecked,
        phoneConfirmed: parsed.data.phoneConfirmed,
        backgroundChecked: parsed.data.backgroundChecked,
        skillAssessed: parsed.data.skillAssessed,
        categoryIds: parsed.data.categoryIds,
        serviceAreaIds: parsed.data.serviceAreaIds,
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

// ─── Week 3: Worker profile update ─────────────────────────────────────────

const UpdateWorkerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().min(1).optional(),
  cnicNumber: z.string().nullable().optional(),
  referenceName: z.string().nullable().optional(),
  referencePhone: z.string().nullable().optional(),
  referenceStatus: z.enum(['UNVERIFIED', 'CONTACTED', 'CONFIRMED', 'FAILED']).optional(),
  identityChecked: z.boolean().optional(),
  phoneConfirmed: z.boolean().optional(),
  backgroundChecked: z.boolean().optional(),
  skillAssessed: z.boolean().optional(),
  categoryIds: z.array(z.string().min(1)).optional(),
  serviceAreaIds: z.array(z.string().min(1)).optional(),
}).strict().refine(
  (data) => {
    // Reject server-owned fields that callers must never supply
    const forbidden = ['rating', 'ratingCount', 'completedJobsCount', 'referenceVerifiedById', 'referenceVerifiedAt', 'agentId', 'status'];
    return !forbidden.some((key) => key in data);
  },
  { message: 'Server-owned fields cannot be modified' },
);

/**
 * PATCH /api/v1/workers/:id
 *
 * Update a worker profile (AGENT assigned to worker, or ADMIN).
 * Does not modify approval status.
 */
router.patch(
  '/:id',
  requireRole('AGENT', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      const parsed = UpdateWorkerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid request body');
      }

      const result = await updateWorker({
        workerId: id,
        callerId: req.user!.userId,
        callerRole: req.user!.role as 'AGENT' | 'ADMIN',
        ...parsed.data,
      });

      return sendSuccess(res, result, 'Worker profile updated');
    } catch (err) {
      next(err);
    }
  },
);

// ─── Week 3: CNIC document upload ──────────────────────────────────────────

// Memory storage — no temporary files on disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CNIC_FILE_SIZE },
});

/**
 * POST /api/v1/workers/:id/documents
 *
 * Upload CNIC documents (multipart/form-data).
 * Accepted fields: cnicFront, cnicBack (at least one required).
 * Only ADMIN or the assigned AGENT may upload.
 */
router.post(
  '/:id/documents',
  requireRole('AGENT', 'ADMIN'),
  upload.fields([
    { name: 'cnicFront', maxCount: 1 },
    { name: 'cnicBack', maxCount: 1 },
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      const files = req.files as Record<string, Express.Multer.File[]>;
      const cnicFront = files?.cnicFront?.[0];
      const cnicBack = files?.cnicBack?.[0];

      if (!cnicFront && !cnicBack) {
        throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'At least one CNIC document must be provided');
      }

      // Validate MIME types
      for (const [fieldName, file] of [['cnicFront', cnicFront], ['cnicBack', cnicBack]] as const) {
        if (file && !ACCEPTED_MIME_TYPES.has(file.mimetype)) {
          throw errors.badRequest(ErrorCode.VALIDATION_ERROR, `Unsupported file type for ${fieldName}`);
        }
      }

      // Create storage adapter — requires service-role key and bucket name
      const bucketName = process.env.SUPABASE_CNIC_BUCKET;
      if (!bucketName) {
        throw errors.internal('CNIC storage bucket is not configured');
      }
      if (!env.supabaseServiceRoleKey) {
        throw errors.internal('Storage service credentials are not configured');
      }

      const storage = createSupabaseStorageAdapter(
        env.supabaseUrl,
        env.supabaseServiceRoleKey,
        bucketName,
      );

      const result = await uploadCnicDocuments({
        workerId: id,
        callerId: req.user!.userId,
        callerRole: req.user!.role as 'AGENT' | 'ADMIN',
        cnicFront: cnicFront ? { buffer: cnicFront.buffer, mimetype: cnicFront.mimetype } : undefined,
        cnicBack: cnicBack ? { buffer: cnicBack.buffer, mimetype: cnicBack.mimetype } : undefined,
        storage,
      });

      return sendSuccess(res, result, 'CNIC documents uploaded', 201);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
