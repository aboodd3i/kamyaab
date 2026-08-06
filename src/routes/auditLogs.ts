/**
 * Audit log routes — audit log query endpoints (Week 6).
 *
 * Supports:
 *   GET /api/v1/audit-logs       — list audit logs (admin only, with filters)
 *   GET /api/v1/audit-logs/:id   — get a single audit log by ID (admin only)
 */

import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import * as auditService from '../services/auditService';

const router = Router();

// All audit log endpoints require authentication + admin role
router.use(authenticate, requireRole('ADMIN'));

/**
 * GET /api/v1/audit-logs
 *
 * List audit log entries, optionally filtered.
 * Admin only.
 *
 * Query params:
 *   action       — AuditAction filter (optional)
 *   actorUserId  — actor filter (optional)
 *   limit        — max results (optional, default 50, max 100)
 */
router.get('/', async (req, res, next) => {
  try {
    const action = req.query.action as string | undefined;
    const actorUserId = req.query.actorUserId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const result = await auditService.listAuditLogs({
      action: action as auditService.AuditAction | undefined,
      actorUserId,
      limit,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/audit-logs/:id
 *
 * Get a single audit log entry by ID.
 * Admin only.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await auditService.getAuditLog(id);
    res.json({ success: true, data: result });
  } catch (err) {
    // If the error is our "not found" sentinel, return 404
    if (err instanceof Error && err.message === 'Audit log entry not found') {
      res.status(404).json({
        success: false,
        error: { code: 'AUDIT_LOG_NOT_FOUND', message: 'Audit log entry not found' },
      });
      return;
    }
    next(err);
  }
});

export default router;
