/**
 * Public Worker DTO — centralized safe serialization for public API responses.
 *
 * This is the ONLY function that maps a Prisma WorkerProfile to a public
 * response shape. Both search and detail endpoints use it.
 *
 * Forbidden fields are never included by construction — the allowlist
 * is explicit and does not delete properties after serialization.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PublicCategorySummary {
  id: string;
  name: string;
}

export interface PublicAreaSummary {
  id: string;
  name: string;
  parentId: string | null;
}

export interface PublicVerificationBadges {
  identityChecked: boolean;
  phoneConfirmed: boolean;
  referenceChecked: boolean;
  backgroundChecked: boolean;
  skillAssessed: boolean;
}

export interface PublicWorker {
  id: string;
  name: string;
  rating: number;
  ratingCount: number;
  completedJobsCount: number;
  verification: PublicVerificationBadges;
  categories: PublicCategorySummary[];
  serviceAreas: PublicAreaSummary[];
}

// ─── Input shape (what the service layer selects from Prisma) ──────────────

interface PrismaWorkerForDto {
  id: string;
  name: string;
  rating: { toString(): string } | number; // Prisma Decimal or number
  ratingCount: number;
  completedJobsCount: number;
  identityChecked: boolean;
  phoneConfirmed: boolean;
  referenceStatus: string; // ReferenceCheckStatus enum
  backgroundChecked: boolean;
  skillAssessed: boolean;
  categories: { category: { id: string; name: string } }[];
  serviceAreas: { area: { id: string; name: string; parentId: string | null } }[];
  // Allow extra fields (e.g. status) from the Prisma select without type errors
  [key: string]: unknown;
}

// ─── Serializer ────────────────────────────────────────────────────────────

/**
 * Convert a Prisma WorkerProfile (with relations) to a public-safe DTO.
 *
 * Uses an explicit allowlist. No forbidden field can appear because
 * it is never assigned.
 */
export function toPublicWorker(worker: PrismaWorkerForDto): PublicWorker {
  return {
    id: worker.id,
    name: worker.name,
    rating: Number(worker.rating),
    ratingCount: worker.ratingCount,
    completedJobsCount: worker.completedJobsCount,
    verification: {
      identityChecked: worker.identityChecked,
      phoneConfirmed: worker.phoneConfirmed,
      referenceChecked: worker.referenceStatus === 'CONFIRMED',
      backgroundChecked: worker.backgroundChecked,
      skillAssessed: worker.skillAssessed,
    },
    categories: worker.categories.map((c) => ({
      id: c.category.id,
      name: c.category.name,
    })),
    serviceAreas: worker.serviceAreas.map((a) => ({
      id: a.area.id,
      name: a.area.name,
      parentId: a.area.parentId,
    })),
  };
}

// ─── Forbidden-key scanner ─────────────────────────────────────────────────

/**
 * Keys that must never appear in a public worker response, at any depth.
 */
export const FORBIDDEN_PUBLIC_KEYS = [
  'phone',
  'phoneNumber',
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
export function findForbiddenKey(obj: unknown, path = ''): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return null;

  const record = obj as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    const fullPath = path ? `${path}.${key}` : key;

    if (FORBIDDEN_PUBLIC_KEYS.includes(key as (typeof FORBIDDEN_PUBLIC_KEYS)[number])) {
      return fullPath;
    }

    const child = record[key];
    if (child !== null && typeof child === 'object') {
      const found = findForbiddenKey(child, fullPath);
      if (found) return found;
    }
  }

  return null;
}
