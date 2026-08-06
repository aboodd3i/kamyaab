/**
 * Complaint DTO — safe serialization for complaint API responses (Week 6).
 *
 * Only allowlisted fields are included. No phone numbers, CNIC,
 * addresses, document paths, reference contacts, or nested Prisma
 * objects (User, Booking, etc.) are ever exposed.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ComplaintDto {
  id: string;
  bookingId: string;
  filedByUserId: string;
  reason: string;
  status: string;
  evidenceFilePaths: string[];
  resolvedByUserId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Input shape (what the service layer returns from Prisma) ──────────────

interface PrismaComplaintForDto {
  id: string;
  bookingId: string;
  filedByUserId: string;
  reason: string;
  status: string;
  evidenceFilePaths: string[];
  resolvedByUserId: string | null;
  resolution: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Serializer ────────────────────────────────────────────────────────────

/**
 * Convert a Prisma Complaint to a safe ComplaintDto.
 *
 * Only allowlisted fields are included. No phone numbers, CNIC,
 * paths, reference info, or raw nested objects ever appear.
 */
export function toComplaintDto(complaint: PrismaComplaintForDto): ComplaintDto {
  return {
    id: complaint.id,
    bookingId: complaint.bookingId,
    filedByUserId: complaint.filedByUserId,
    reason: complaint.reason,
    status: complaint.status,
    evidenceFilePaths: complaint.evidenceFilePaths,
    resolvedByUserId: complaint.resolvedByUserId,
    resolution: complaint.resolution,
    resolvedAt: complaint.resolvedAt ? complaint.resolvedAt.toISOString() : null,
    createdAt: complaint.createdAt.toISOString(),
    updatedAt: complaint.updatedAt.toISOString(),
  };
}

// ─── Forbidden-key scanner ─────────────────────────────────────────────────

/**
 * Keys that must never appear in a complaint response, at any depth.
 */
export const FORBIDDEN_COMPLAINT_KEYS = [
  'clientPhone',
  'workerPhone',
  'cnicNumber',
  'cnicFrontPath',
  'cnicBackPath',
  'referenceName',
  'referencePhone',
  'referenceStatus',
  'referenceVerifiedById',
  'referenceVerifiedAt',
  'agentId',
  'suspensionReason',
  'authUserId',
  'email',
  'address',
  'exactAddress',
  'documentPath',
  'storagePath',
] as const;

/**
 * Recursively scan an object for forbidden keys.
 * Returns the first forbidden key found, or null if none.
 */
export function findForbiddenComplaintKey(obj: unknown, path = ''): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return null;

  const record = obj as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    const fullPath = path ? `${path}.${key}` : key;

    if (FORBIDDEN_COMPLAINT_KEYS.includes(key as (typeof FORBIDDEN_COMPLAINT_KEYS)[number])) {
      return fullPath;
    }

    const child = record[key];
    if (child !== null && typeof child === 'object') {
      const found = findForbiddenComplaintKey(child, fullPath);
      if (found) return found;
    }
  }

  return null;
}
