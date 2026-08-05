/**
 * Audit log DTO — safe serialization for audit log API responses (Week 6).
 *
 * Only allowlisted fields are included. No phone numbers, CNIC,
 * addresses, document paths, reference contacts, or nested Prisma
 * objects are ever exposed.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AuditLogDto {
  id: string;
  action: string;
  actorUserId: string;
  bookingId: string | null;
  reviewId: string | null;
  complaintId: string | null;
  workerId: string | null;
  summary: string;
  metadata: unknown;
  createdAt: string;
}

// ─── Input shape (what the service layer returns from Prisma) ──────────────

interface PrismaAuditLogForDto {
  id: string;
  action: string;
  actorUserId: string;
  bookingId: string | null;
  reviewId: string | null;
  complaintId: string | null;
  workerId: string | null;
  summary: string;
  metadata: unknown;
  createdAt: Date;
}

// ─── Serializer ────────────────────────────────────────────────────────────

/**
 * Convert a Prisma AuditLog to a safe AuditLogDto.
 */
export function toAuditLogDto(log: PrismaAuditLogForDto): AuditLogDto {
  return {
    id: log.id,
    action: log.action,
    actorUserId: log.actorUserId,
    bookingId: log.bookingId,
    reviewId: log.reviewId,
    complaintId: log.complaintId,
    workerId: log.workerId,
    summary: log.summary,
    metadata: log.metadata,
    createdAt: log.createdAt.toISOString(),
  };
}
