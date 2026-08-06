/**
 * Booking DTO — safe serialization for booking API responses.
 *
 * Only allowlisted fields are included. Contact phone numbers
 * (clientPhone, workerPhone) are intentionally excluded — they
 * are available through GET /api/v1/job-requests/mine for the
 * client side and are not needed in the booking-completion response.
 *
 * No CNIC, addresses, document paths, reference info, or raw nested
 * User/ClientProfile/WorkerProfile/JobRequest objects are included.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BookingDto {
  id: string;
  jobRequestId: string;
  workerId: string;
  status: string;
  confirmedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Input shape (what the service layer returns from Prisma) ──────────────

interface PrismaBookingForDto {
  id: string;
  jobRequestId: string;
  workerId: string;
  status: string;
  confirmedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Serializer ────────────────────────────────────────────────────────────

/**
 * Convert a Prisma Booking to a safe BookingDto.
 *
 * Only allowlisted fields are included. No contact phones, CNIC,
 * paths, reference info, or raw nested objects ever appear.
 */
export function toBookingDto(booking: PrismaBookingForDto): BookingDto {
  return {
    id: booking.id,
    jobRequestId: booking.jobRequestId,
    workerId: booking.workerId,
    status: booking.status,
    confirmedAt: booking.confirmedAt.toISOString(),
    completedAt: booking.completedAt ? booking.completedAt.toISOString() : null,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

// ─── Forbidden-key scanner ─────────────────────────────────────────────────

/**
 * Keys that must never appear in a booking response, at any depth.
 */
export const FORBIDDEN_BOOKING_KEYS = [
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
  'userId',
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
export function findForbiddenBookingKey(obj: unknown, path = ''): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return null;

  const record = obj as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    const fullPath = path ? `${path}.${key}` : key;

    if (FORBIDDEN_BOOKING_KEYS.includes(key as (typeof FORBIDDEN_BOOKING_KEYS)[number])) {
      return fullPath;
    }

    const child = record[key];
    if (child !== null && typeof child === 'object') {
      const found = findForbiddenBookingKey(child, fullPath);
      if (found) return found;
    }
  }

  return null;
}
