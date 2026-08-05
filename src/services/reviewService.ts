/**
 * Review service (Week 6) — internal reusable methods for review operations.
 *
 * This module provides the service-layer logic for the review system.
 * No Express handlers or routes are registered here — routes remain thin.
 *
 * createReview implements the CLIENT_TO_WORKER review flow:
 *   - resolves ownership from the trusted authenticated user
 *   - validates booking eligibility (COMPLETED, owned by caller)
 *   - prevents duplicates via unique constraint + transaction
 *   - maps through the safe DTO
 *   - never returns raw Prisma objects
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { toReviewDto, type ReviewDto } from '../lib/reviewDto';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Direction of a review — who is reviewing whom. */
export type ReviewDirection = 'CLIENT_TO_WORKER' | 'WORKER_TO_CLIENT';

/** Fields selected from Prisma for the DTO. */
const REVIEW_SELECT = {
  id: true,
  bookingId: true,
  direction: true,
  rating: true,
  comment: true,
  createdAt: true,
  updatedAt: true,
  reviewerUserId: true,
  revieweeUserId: true,
} as const;

// ─── Internal Methods ──────────────────────────────────────────────────────

/**
 * Shared internal helper — insert a review inside a transaction and
 * translate Prisma P2002 unique-constraint violations into
 * REVIEW_ALREADY_EXISTS.  Never exposes raw Prisma errors.
 *
 * Used by both createReview (CLIENT_TO_WORKER) and createWorkerReview
 * (WORKER_TO_CLIENT).
 */
async function insertReview(
  bookingId: string,
  reviewerUserId: string,
  revieweeUserId: string,
  direction: ReviewDirection,
  rating: number,
  comment?: string | null,
): Promise<ReviewDto> {
  try {
    const review = await prisma.$transaction(async (tx) => {
      return tx.review.create({
        data: {
          bookingId,
          reviewerUserId,
          revieweeUserId,
          direction,
          rating,
          comment: comment ?? null,
        },
        select: REVIEW_SELECT,
      });
    });

    return toReviewDto(review);
  } catch (err) {
    // Translate Prisma P2002 unique constraint violation → REVIEW_ALREADY_EXISTS
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === 'P2002'
    ) {
      throw errors.conflict(
        ErrorCode.REVIEW_ALREADY_EXISTS,
        'A review for this booking already exists',
      );
    }
    throw err;
  }
}

/**
 * Create a CLIENT_TO_WORKER review for a completed booking.
 *
 * Authorization & Ownership:
 *   - The caller must be a CLIENT (enforced at the route layer).
 *   - The caller's ClientProfile must own the JobRequest linked to the booking.
 *   - Ownership failure returns a generic not-found (no information leakage).
 *
 * Booking Eligibility:
 *   - The booking must exist.
 *   - The booking status must be COMPLETED.
 *   - The booking must have a linked worker with a linked User.
 *
 * Duplicate Prevention:
 *   - Exactly one CLIENT_TO_WORKER review per booking (enforced by DB unique constraint).
 *   - If a review already exists, returns REVIEW_ALREADY_EXISTS (409).
 *   - Unique constraint violations from concurrent inserts are translated
 *     to REVIEW_ALREADY_EXISTS — raw Prisma errors are never exposed.
 *
 * Concurrency:
 *   - The insert runs inside a transaction. If two concurrent requests
 *     race, the unique constraint on (bookingId, direction) ensures
 *     exactly one row is created. The loser's P2002 error is caught
 *     and translated to a REVIEW_ALREADY_EXISTS AppError.
 *
 * @param bookingId   The booking to review (from request body).
 * @param reviewerUserId  The authenticated client's internal User ID (trusted, server-side).
 * @param rating      1–5 integer (validated by Zod at the route layer).
 * @param comment     Optional trimmed comment (max 1000 chars).
 * @returns Safe ReviewDto — never a raw Prisma object.
 */
export async function createReview(
  bookingId: string,
  reviewerUserId: string,
  rating: number,
  comment?: string | null,
): Promise<ReviewDto> {
  // Resolve the client profile from the trusted user ID
  const clientProfile = await prisma.clientProfile.findUnique({
    where: { userId: reviewerUserId },
    select: { id: true },
  });

  if (!clientProfile) {
    throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Client profile not found');
  }

  // Load the booking with ownership and worker info
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      jobRequest: { select: { clientId: true } },
      worker: { select: { userId: true } },
    },
  });

  // Generic not-found if booking doesn't exist OR client doesn't own it.
  // This avoids leaking whether another client's booking exists.
  if (!booking || booking.jobRequest.clientId !== clientProfile.id) {
    throw errors.notFound(ErrorCode.BOOKING_NOT_FOUND, 'Booking not found');
  }

  // Only completed bookings may be reviewed
  if (booking.status !== 'COMPLETED') {
    throw errors.badRequest(
      ErrorCode.REVIEW_NOT_ALLOWED,
      'Only completed bookings may be reviewed',
    );
  }

  // The booking must have a worker with a linked User
  if (!booking.worker.userId) {
    throw errors.badRequest(
      ErrorCode.REVIEW_NOT_ALLOWED,
      'Booking worker is not linked to a user account',
    );
  }

  return insertReview(
    bookingId,
    reviewerUserId,
    booking.worker.userId,
    'CLIENT_TO_WORKER',
    rating,
    comment,
  );
}

/**
 * Create a WORKER_TO_CLIENT review for a completed booking.
 *
 * Authorization & Ownership:
 *   - The caller must be a WORKER (enforced at the route layer).
 *   - The caller's WorkerProfile must be the worker assigned to the booking.
 *   - Ownership failure returns a generic not-found (no information leakage).
 *
 * Booking Eligibility:
 *   - The booking must exist.
 *   - The booking status must be COMPLETED.
 *   - The booking must have a linked client with a linked User.
 *
 * Duplicate Prevention:
 *   - Exactly one WORKER_TO_CLIENT review per booking (enforced by DB unique constraint).
 *   - If a review already exists, returns REVIEW_ALREADY_EXISTS (409).
 *   - Unique constraint violations from concurrent inserts are translated
 *     to REVIEW_ALREADY_EXISTS — raw Prisma errors are never exposed.
 *
 * Concurrency:
 *   - The insert runs inside a transaction. If two concurrent requests
 *     race, the unique constraint on (bookingId, direction) ensures
 *     exactly one row is created. The loser's P2002 error is caught
 *     and translated to a REVIEW_ALREADY_EXISTS AppError.
 *
 * @param bookingId   The booking to review (from request body).
 * @param reviewerUserId  The authenticated worker's internal User ID (trusted, server-side).
 * @param rating      1–5 integer (validated by Zod at the route layer).
 * @param comment     Optional trimmed comment (max 1000 chars).
 * @returns Safe ReviewDto — never a raw Prisma object.
 */
export async function createWorkerReview(
  bookingId: string,
  reviewerUserId: string,
  rating: number,
  comment?: string | null,
): Promise<ReviewDto> {
  // Resolve the worker profile from the trusted user ID
  const workerProfile = await prisma.workerProfile.findUnique({
    where: { userId: reviewerUserId },
    select: { id: true },
  });

  if (!workerProfile) {
    throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Worker profile not found');
  }

  // Load the booking with ownership and client info
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      workerId: true,
      jobRequest: {
        select: {
          client: { select: { userId: true } },
        },
      },
    },
  });

  // Generic not-found if booking doesn't exist OR worker doesn't own it.
  // This avoids leaking whether another worker's booking exists.
  if (!booking || booking.workerId !== workerProfile.id) {
    throw errors.notFound(ErrorCode.BOOKING_NOT_FOUND, 'Booking not found');
  }

  // Only completed bookings may be reviewed
  if (booking.status !== 'COMPLETED') {
    throw errors.badRequest(
      ErrorCode.REVIEW_NOT_ALLOWED,
      'Only completed bookings may be reviewed',
    );
  }

  // The booking must have a client with a linked User
  if (!booking.jobRequest.client.userId) {
    throw errors.badRequest(
      ErrorCode.REVIEW_NOT_ALLOWED,
      'Booking client is not linked to a user account',
    );
  }

  return insertReview(
    bookingId,
    reviewerUserId,
    booking.jobRequest.client.userId,
    'WORKER_TO_CLIENT',
    rating,
    comment,
  );
}

/**
 * Find a single review by booking ID and direction.
 *
 * Returns a safe ReviewDto or null if not found.
 * This is a read-only method and is safe to expose.
 *
 * @param bookingId   The booking to look up.
 * @param direction   The review direction (CLIENT_TO_WORKER or WORKER_TO_CLIENT).
 */
export async function findReview(
  bookingId: string,
  direction: ReviewDirection,
): Promise<ReviewDto | null> {
  const review = await prisma.review.findUnique({
    where: {
      bookingId_direction: { bookingId, direction },
    },
    select: REVIEW_SELECT,
  });

  if (!review) return null;
  return toReviewDto(review);
}

/**
 * Check whether a review already exists for a booking + direction.
 *
 * Returns true if a review exists, false otherwise.
 * This is a lightweight read-only check.
 *
 * @param bookingId   The booking to check.
 * @param direction   The review direction.
 */
export async function reviewExists(
  bookingId: string,
  direction: ReviewDirection,
): Promise<boolean> {
  const count = await prisma.review.count({
    where: {
      bookingId,
      direction,
    },
  });

  return count > 0;
}

/**
 * Find all reviews for a given booking.
 *
 * Returns an array of safe ReviewDtos (0, 1, or 2 entries).
 * This is a read-only method.
 *
 * @param bookingId   The booking to look up.
 */
export async function findReviewsForBooking(bookingId: string): Promise<ReviewDto[]> {
  const reviews = await prisma.review.findMany({
    where: { bookingId },
    select: REVIEW_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  return reviews.map(toReviewDto);
}
