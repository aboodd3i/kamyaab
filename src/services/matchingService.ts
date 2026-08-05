/**
 * Matching service (Week 5) — deterministic worker matching for OPEN job requests.
 *
 * Given an OPEN job request, finds all APPROVED workers who:
 *   - Offer the requested category
 *   - Serve the requested area
 *   - Are not marked UNAVAILABLE
 *
 * Ranks them by:
 *   1. isPriorityListed DESC (paid priority listing boost)
 *   2. rating DESC
 *   3. completedJobsCount DESC
 *   4. id ASC (deterministic tiebreaker)
 *
 * Returns the top N matches (default 10).
 *
 * This is NOT AI-based matching — it is a deterministic, transparent
 * ranking function per the pitch deck (AI matching is Phase 2).
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { toMatchResult, type MatchResult } from '../lib/matchingDto';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Maximum number of workers to match and invite for a single OPEN job. */
export const MAX_MATCHES = 10;

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Raw worker data fetched from Prisma for matching.
 * We fetch all candidates in a single query and sort in JS because
 * Prisma's orderBy doesn't support the priority-listed-first logic
 * cleanly with the availability join.
 */
interface MatchCandidate {
  id: string;
  name: string;
  rating: { toString(): string };
  ratingCount: number;
  completedJobsCount: number;
  isPriorityListed: boolean;
  availability: { status: string } | null;
}

// ─── findMatchingWorkers ───────────────────────────────────────────────────

/**
 * Find and rank workers for an OPEN job request.
 *
 * @param jobRequestId  The ID of the OPEN job request to match for.
 * @param maxMatches    Maximum number of workers to return (default 10).
 * @returns             Array of MatchResult, ranked best-first.
 *
 * @throws AppError(404) if the job request doesn't exist.
 * @throws AppError(400) if the job request is not type=OPEN.
 * @throws AppError(400) if the job request is not in DRAFT status.
 */
export async function findMatchingWorkers(
  jobRequestId: string,
  maxMatches: number = MAX_MATCHES,
): Promise<MatchResult[]> {
  // Fetch the job request to validate it's an OPEN draft
  const jobRequest = await prisma.jobRequest.findUnique({
    where: { id: jobRequestId },
    select: {
      id: true,
      type: true,
      status: true,
      categoryId: true,
      areaId: true,
    },
  });

  if (!jobRequest) {
    throw errors.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Job request not found');
  }

  if (jobRequest.type !== 'OPEN') {
    throw errors.badRequest(
      ErrorCode.VALIDATION_ERROR,
      'Matching is only available for OPEN job requests',
    );
  }

  if (jobRequest.status !== 'DRAFT') {
    throw errors.badRequest(
      ErrorCode.INVALID_STATE_TRANSITION,
      'Only draft job requests can be matched',
    );
  }

  // Query all APPROVED workers who offer the category and serve the area
  const candidates = await prisma.workerProfile.findMany({
    where: {
      status: 'APPROVED',
      categories: { some: { categoryId: jobRequest.categoryId } },
      serviceAreas: { some: { areaId: jobRequest.areaId } },
    },
    select: {
      id: true,
      name: true,
      rating: true,
      ratingCount: true,
      completedJobsCount: true,
      isPriorityListed: true,
      availability: {
        select: { status: true },
      },
    },
  }) as MatchCandidate[];

  // Filter out UNAVAILABLE workers
  const eligible = candidates.filter(
    (w) => !w.availability || w.availability.status !== 'UNAVAILABLE',
  );

  // Sort by: isPriorityListed DESC → rating DESC → completedJobsCount DESC → id ASC
  eligible.sort((a, b) => {
    // Priority-listed workers first
    if (a.isPriorityListed !== b.isPriorityListed) {
      return b.isPriorityListed ? 1 : -1;
    }
    // Higher rating first
    const ratingA = Number(a.rating);
    const ratingB = Number(b.rating);
    if (ratingB !== ratingA) {
      return ratingB - ratingA;
    }
    // More completed jobs first
    if (b.completedJobsCount !== a.completedJobsCount) {
      return b.completedJobsCount - a.completedJobsCount;
    }
    // Deterministic tiebreaker
    return a.id.localeCompare(b.id);
  });

  // Take top N and convert to DTOs with rank
  const topMatches = eligible.slice(0, maxMatches);
  return topMatches.map((worker, index) => toMatchResult(worker, index + 1));
}
