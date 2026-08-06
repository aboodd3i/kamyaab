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
import {
  createComplaintSchema,
  resolveComplaintSchema,
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_FILE_SIZE,
  ACCEPTED_EVIDENCE_MIME_TYPES,
} from '../lib/complaintValidation';
import * as complaintService from '../services/complaintService';
import { createSupabaseStorageAdapter } from '../services/supabaseStorageAdapter';
import multer from 'multer';
import { env } from '../config/env';

const router = Router();

// Multer setup for evidence file uploads — memory storage, no disk files
const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_FILE_SIZE },
});

// All complaint endpoints require authentication
router.use(authenticate);

/**
 * POST /api/v1/complaints
 *
 * File a complaint against a booking (multipart/form-data).
 *
 * Form fields:
 *   bookingId  — required — the booking to complain about
 *   reason     — required — trimmed, max 2000 chars
 *   evidence   — optional — file field, up to 5 files (images/PDF, max 5 MiB each)
 *
 * Any authenticated user may file a complaint.
 */
router.post(
  '/',
  evidenceUpload.array('evidence', MAX_EVIDENCE_FILES),
  async (req, res, next) => {
    try {
      const bookingId = req.body.bookingId as string | undefined;
      const reason = req.body.reason as string | undefined;

      if (typeof bookingId !== 'string' || bookingId.trim().length === 0) {
        throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Valid bookingId is required');
      }

      const parsed = createComplaintSchema.parse({ reason });

      // Process evidence files if present
      const files = req.files as Express.Multer.File[] | undefined;
      const evidenceFiles: complaintService.EvidenceFile[] = [];

      if (files && files.length > 0) {
        if (files.length > MAX_EVIDENCE_FILES) {
          throw errors.badRequest(
            ErrorCode.VALIDATION_ERROR,
            `Maximum ${MAX_EVIDENCE_FILES} evidence files allowed`,
          );
        }

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!ACCEPTED_EVIDENCE_MIME_TYPES.has(file.mimetype)) {
            throw errors.badRequest(
              ErrorCode.VALIDATION_ERROR,
              `Unsupported file type for evidence file ${i + 1}`,
            );
          }
          evidenceFiles.push({ buffer: file.buffer, mimetype: file.mimetype });
        }
      }

      let result;
      if (evidenceFiles.length > 0) {
        // Create storage adapter — requires service-role key and bucket name
        const bucketName = process.env.SUPABASE_COMPLAINT_BUCKET;
        if (!bucketName) {
          throw errors.internal('Complaint evidence storage bucket is not configured');
        }
        if (!env.supabaseServiceRoleKey) {
          throw errors.internal('Storage service credentials are not configured');
        }

        const storage = createSupabaseStorageAdapter(
          env.supabaseUrl,
          env.supabaseServiceRoleKey,
          bucketName,
        );

        result = await complaintService.uploadComplaintEvidence({
          bookingId: bookingId.trim(),
          filedByUserId: req.user!.userId,
          reason: parsed.reason,
          evidenceFiles,
          storage,
        });
      } else {
        // No evidence files — skip storage entirely
        result = await complaintService.createComplaint(
          bookingId.trim(),
          req.user!.userId,
          parsed.reason,
        );
      }

      res.status(201).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

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
