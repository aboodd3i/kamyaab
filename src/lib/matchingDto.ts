/**
 * Matching DTO — safe serialization for open-job match results.
 *
 * Used by the matching service to return ranked worker matches for an
 * OPEN job request. Sensitive fields (phone, CNIC, address, reference
 * contact) are never included.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MatchResult {
  workerId: string;
  workerName: string;
  rating: number;
  ratingCount: number;
  completedJobsCount: number;
  isPriorityListed: boolean;
  availabilityStatus: string;
  /** 1-based rank position in the result set (1 = best match). */
  rank: number;
}

// ─── Input shape (what the service layer selects from Prisma) ──────────────

interface PrismaMatchForDto {
  id: string;
  name: string;
  rating: { toString(): string } | number;
  ratingCount: number;
  completedJobsCount: number;
  isPriorityListed: boolean;
  availability: { status: string } | null;
}

// ─── Serializer ────────────────────────────────────────────────────────────

/**
 * Convert a Prisma WorkerProfile (with availability) to a safe match DTO.
 */
export function toMatchResult(worker: PrismaMatchForDto, rank: number): MatchResult {
  return {
    workerId: worker.id,
    workerName: worker.name,
    rating: Number(worker.rating),
    ratingCount: worker.ratingCount,
    completedJobsCount: worker.completedJobsCount,
    isPriorityListed: worker.isPriorityListed,
    availabilityStatus: worker.availability?.status ?? 'UNKNOWN',
    rank,
  };
}
