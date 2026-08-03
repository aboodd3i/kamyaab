/**
 * My Jobs DTO — safe serialization for GET /api/v1/job-requests/mine.
 *
 * Worker contact information (phone) is released ONLY when an accepted
 * booking exists for the job request. The booking is a server-controlled
 * record created exclusively inside the invitation-acceptance transaction,
 * so it cannot be triggered by a client-editable request field.
 *
 * Before acceptance (DRAFT, WORKER_CONTACTED, EXPIRED, CANCELLED) the
 * worker phone is returned as null. All other sensitive fields (CNIC,
 * addresses, document paths, reference-contact info) are never included.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MyJobCategorySummary {
  id: string;
  name: string;
}

export interface MyJobAreaSummary {
  id: string;
  name: string;
}

export interface MyJobTargetWorkerSummary {
  id: string;
  name: string;
  /** Worker phone — null until a booking (accepted invitation) exists. */
  phone: string | null;
}

export interface MyJobBookingSummary {
  id: string;
  status: string;
  confirmedAt: string;
}

export interface MyJobItem {
  id: string;
  status: string;
  type: string;
  description: string;
  urgency: string;
  budget: number | null;
  category: MyJobCategorySummary;
  area: MyJobAreaSummary;
  targetWorker: MyJobTargetWorkerSummary | null;
  /** Present only when a booking has been created (invitation accepted). */
  booking: MyJobBookingSummary | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Input shape (what the service layer selects from Prisma) ──────────────

interface PrismaJobForDto {
  id: string;
  status: string;
  type: string;
  description: string;
  urgency: string;
  budget: { toString(): string } | number | null;
  category: { id: string; name: string };
  area: { id: string; name: string };
  targetWorker: { id: string; name: string } | null;
  booking:
    | {
        id: string;
        status: string;
        confirmedAt: Date;
        workerPhone: string | null;
      }
    | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Serializer ────────────────────────────────────────────────────────────

/**
 * Convert a Prisma JobRequest (with safe relations) to a My Jobs DTO.
 *
 * Contact release rule:
 *   worker phone is included if and only if a booking row exists.
 *   The booking is created server-side on invitation acceptance —
 *   never settable by the client.
 */
export function toMyJobItem(job: PrismaJobForDto): MyJobItem {
  const hasBooking = job.booking !== null;

  return {
    id: job.id,
    status: job.status,
    type: job.type,
    description: job.description,
    urgency: job.urgency,
    budget: job.budget === null ? null : Number(job.budget),
    category: {
      id: job.category.id,
      name: job.category.name,
    },
    area: {
      id: job.area.id,
      name: job.area.name,
    },
    targetWorker: job.targetWorker
      ? {
          id: job.targetWorker.id,
          name: job.targetWorker.name,
          // Release phone only when a booking exists
          phone: hasBooking ? job.booking!.workerPhone : null,
        }
      : null,
    booking: job.booking
      ? {
          id: job.booking.id,
          status: job.booking.status,
          confirmedAt: job.booking.confirmedAt.toISOString(),
        }
      : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

// ─── Forbidden-key scanner ─────────────────────────────────────────────────

/**
 * Keys that must never appear in a My Jobs response, at any depth.
 *
 * `workerPhone` on the booking is the only allowed contact field and is
 * server-controlled. The targetWorker.phone field is allowed (it is null
 * before acceptance) so `phone` itself is not forbidden — but all other
 * sensitive worker fields are.
 */
export const FORBIDDEN_MYJOB_KEYS = [
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
  'clientPhone',
] as const;

/**
 * Recursively scan an object for forbidden keys.
 * Returns the first forbidden key found, or null if none.
 */
export function findForbiddenMyJobKey(obj: unknown, path = ''): string | null {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return null;

  const record = obj as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    const fullPath = path ? `${path}.${key}` : key;

    if (FORBIDDEN_MYJOB_KEYS.includes(key as (typeof FORBIDDEN_MYJOB_KEYS)[number])) {
      return fullPath;
    }

    const child = record[key];
    if (child !== null && typeof child === 'object') {
      const found = findForbiddenMyJobKey(child, fullPath);
      if (found) return found;
    }
  }

  return null;
}
