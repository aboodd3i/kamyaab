/**
 * Review service (Week 6) — internal reusable methods for review operations.
 *
 * This module establishes the service-layer interfaces and transaction
 * boundaries for the review system. No Express handlers or routes
 * are registered here — those will be added in a future task.
 *
 * The createReview method intentionally throws NOT_IMPLEMENTED until
 * the API endpoint is added in the next task.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { toReviewDto, type ReviewDto } from '../lib/reviewDto';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Direction of a review — who is reviewing whom. */
export type ReviewDirection = 'CLIENT_TO_WORKER' | 'WORKER_TO_CLIENT';

/** Input for creating a review. */
export interface CreateReviewInput {
  bookingId: string;
  reviewerUserId: string;
  revieweeUserId: string;
  direction: ReviewDirection;
  rating: number;
  comment?: string | null;
}

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
 * Create a review for a booking.
 *
 * NOT IMPLEMENTED — this method intentionally throws until the API
 * endpoint is added in the next task. The signature and transaction
 * boundary are established here for interface stability.
 *
 * When implemented, this method will:
 *   1. Verify the booking exists and is COMPLETED.
 *   2. Verify the reviewer is a participant in the booking.
 *   3. Verify no review already exists for this booking + direction.
 *   4. Insert the review within a transaction.
 *   5. Return a safe ReviewDto.
 *
 * @throws AppError(NOT_IMPLEMENTED) — always, until the endpoint is added.
 */
export async function createReview(_input: CreateReviewInput): Promise<ReviewDto> {
  throw errors.badRequest(
    ErrorCode.NOT_IMPLEMENTED,
    'Review creation is not yet implemented',
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
