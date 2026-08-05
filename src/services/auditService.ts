/**
 * Audit service (Week 6) — records significant state changes for compliance
 * and debugging.
 *
 * logAction is the core write method. It NEVER throws — if the database
 * insert fails, the error is logged to console but never propagated to
 * the caller. This ensures that audit logging failures never break the
 * primary business operation.
 *
 * getAuditLog / listAuditLogs are read-only methods for admin queries.
 */

import prisma from '../lib/prisma';
import { toAuditLogDto, type AuditLogDto } from '../lib/auditLogDto';

// ─── Types ─────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'BOOKING_COMPLETED'
  | 'REVIEW_CREATED'
  | 'COMPLAINT_FILED'
  | 'COMPLAINT_RESOLVED'
  | 'WORKER_STATUS_CHANGED'
  | 'INVITATION_RESPONDED';

/** Fields selected from Prisma for the DTO. */
const AUDIT_LOG_SELECT = {
  id: true,
  action: true,
  actorUserId: true,
  bookingId: true,
  reviewId: true,
  complaintId: true,
  workerId: true,
  summary: true,
  metadata: true,
  createdAt: true,
} as const;

// ─── logAction ─────────────────────────────────────────────────────────────

/**
 * Record an audit log entry.
 *
 * This function NEVER throws. If the database insert fails, the error
 * is logged to console.error but the promise resolves successfully.
 * This is critical — audit logging must never break the primary
 * business operation that triggered it.
 *
 * @param params.action       What kind of action was performed.
 * @param params.actorUserId  Who performed the action (internal User ID).
 * @param params.bookingId    Optional booking involved.
 * @param params.reviewId     Optional review involved.
 * @param params.complaintId  Optional complaint involved.
 * @param params.workerId     Optional worker involved.
 * @param params.summary      Human-readable summary.
 * @param params.metadata     Optional structured metadata (JSON).
 */
export async function logAction(params: {
  action: AuditAction;
  actorUserId: string;
  bookingId?: string;
  reviewId?: string;
  complaintId?: string;
  workerId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: params.action,
        actorUserId: params.actorUserId,
        bookingId: params.bookingId ?? null,
        reviewId: params.reviewId ?? null,
        complaintId: params.complaintId ?? null,
        workerId: params.workerId ?? null,
        summary: params.summary,
        metadata: params.metadata
          ? (params.metadata as Record<string, unknown> as never)
          : undefined,
      },
      select: AUDIT_LOG_SELECT,
    });
  } catch (err) {
    // Audit logging must NEVER throw — log and swallow.
    console.error('Audit log write failed (non-fatal):', err);
  }
}

// ─── Read Methods ──────────────────────────────────────────────────────────

/**
 * Get a single audit log entry by ID.
 *
 * @param id The audit log entry to look up.
 * @returns Safe AuditLogDto or throws AUDIT_LOG_NOT_FOUND.
 */
export async function getAuditLog(id: string): Promise<AuditLogDto> {
  const log = await prisma.auditLog.findUnique({
    where: { id },
    select: AUDIT_LOG_SELECT,
  });

  if (!log) {
    throw new Error('Audit log entry not found');
  }

  return toAuditLogDto(log);
}

/**
 * List audit log entries, optionally filtered by action and/or actor.
 *
 * @param params.action   Optional action filter.
 * @param params.actorUserId Optional actor filter.
 * @param params.limit    Maximum number of results (default 50, max 100).
 * @returns Array of safe AuditLogDto objects, newest first.
 */
export async function listAuditLogs(params: {
  action?: AuditAction;
  actorUserId?: string;
  limit?: number;
} = {}): Promise<AuditLogDto[]> {
  const { action, actorUserId, limit = 50 } = params;

  const where: Record<string, unknown> = {};
  if (action) where.action = action;
  if (actorUserId) where.actorUserId = actorUserId;

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    select: AUDIT_LOG_SELECT,
  });

  return logs.map(toAuditLogDto);
}
