/**
 * Review DTO — safe serialization for review API responses (Week 6).
 *
 * Only allowlisted fields are included. No phone numbers, CNIC,
 * addresses, document paths, reference contacts, or nested Prisma
 * objects (User, Booking, etc.) are ever exposed.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ReviewDto {
  id: string;
  bookingId: string;
  direction: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  reviewerUserId: string;
  revieweeUserId: string;
}

// ─── Input shape (what the service layer returns from Prisma) ──────────────

interface PrismaReviewForDto {
  id: string;
  bookingId: string;
  direction: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
  reviewerUserId: string;
  revieweeUserId: string;
}

// ─── Serializer ────────────────────────────────────────────────────────────

/**
 * Convert a Prisma Review to a safe ReviewDto.
 *
 * Only allowlisted fields are included. No phone numbers, CNIC,
 * paths, reference info, or raw nested objects ever appear.
 */
export function toReviewDto(review: PrismaReviewForDto): ReviewDto {
  return {
    id: review.id,
    bookingId: review.bookingId,
    direction: review.direction,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
    reviewerUserId: review.reviewerUserId,
    revieweeUserId: review.revieweeUserId,
  };
}

// ─── Forbidden-key scanner ─────────────────────────────────────────────────

/**
 * Keys that must never appear in a review response, at any depth.
 */
export const FORBIDDEN_REVIEW_KEYS = [
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
export function findForbiddenReviewKey(obj: unknown, path = ''): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return null;

  const record = obj as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    const fullPath = path ? `${path}.${key}` : key;

    if (FORBIDDEN_REVIEW_KEYS.includes(key as (typeof FORBIDDEN_REVIEW_KEYS)[number])) {
      return fullPath;
    }

    const child = record[key];
    if (child !== null && typeof child === 'object') {
      const found = findForbiddenReviewKey(child, fullPath);
      if (found) return found;
    }
  }

  return null;
}
