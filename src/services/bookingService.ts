/**
 * Booking service — handles booking lifecycle operations.
 *
 * Currently supports client-controlled booking completion:
 *   CONFIRMED → COMPLETED
 *
 * The authenticated client must own the JobRequest linked to the booking.
 * Completion is idempotent and concurrency-safe.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { toBookingDto } from '../lib/bookingDto';
import { logAction } from './auditService';

/** Fields selected from Prisma for the DTO — never includes contact phones. */
const BOOKING_SELECT = {
  id: true,
  jobRequestId: true,
  workerId: true,
  status: true,
  confirmedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Complete a booking as the owning client.
 *
 * Authorization:
 *   - The caller must be a CLIENT.
 *   - The caller's ClientProfile must own the JobRequest linked to the booking.
 *
 * Idempotency:
 *   - If the booking is already COMPLETED, return it without side effects.
 *
 * Concurrency:
 *   - Uses a conditional update (WHERE status = 'CONFIRMED') to ensure
 *     exactly one transition occurs even under concurrent requests.
 *   - If the conditional update affects 0 rows, re-reads the booking
 *     to determine whether it was already completed (return success)
 *     or is in an invalid state (return error).
 *
 * @param bookingId   The booking to complete.
 * @param userId      The authenticated user's internal ID (trusted, server-side).
 * @returns Safe BookingDto — never a raw Prisma object.
 */
export async function completeBooking(bookingId: string, userId: string) {
  // Resolve the client profile from the trusted user ID
  const clientProfile = await prisma.clientProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!clientProfile) {
    throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Client profile not found');
  }

  // Load the booking with its job request to check ownership
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      ...BOOKING_SELECT,
      jobRequest: {
        select: { clientId: true },
      },
    },
  });

  // Generic not-found if the booking doesn't exist OR the client doesn't own it.
  // This avoids leaking whether another client's booking exists.
  if (!booking || booking.jobRequest.clientId !== clientProfile.id) {
    throw errors.notFound(ErrorCode.BOOKING_NOT_FOUND, 'Booking not found');
  }

  // Idempotent: already completed — return without side effects
  if (booking.status === 'COMPLETED') {
    return toBookingDto(booking);
  }

  // Invalid transition: only CONFIRMED → COMPLETED is allowed
  if (booking.status !== 'CONFIRMED') {
    throw errors.badRequest(
      ErrorCode.BOOKING_INVALID_STATE,
      `Booking cannot be completed from status ${booking.status}`,
    );
  }

  // Concurrency-safe conditional update: only update if still CONFIRMED.
  // This prevents a race where two concurrent requests both read CONFIRMED
  // and both try to update. The conditional WHERE ensures exactly one wins.
  const updated = await prisma.booking.updateMany({
    where: {
      id: bookingId,
      status: 'CONFIRMED',
    },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    // Another concurrent request completed it between our read and update.
    // Re-read to get the current state and return it idempotently.
    const currentBooking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: BOOKING_SELECT,
    });

    if (currentBooking && currentBooking.status === 'COMPLETED') {
      return toBookingDto(currentBooking);
    }

    // If it's not COMPLETED, something unexpected happened (e.g., it was
    // CANCELLED concurrently). Return the appropriate error.
    throw errors.badRequest(
      ErrorCode.BOOKING_INVALID_STATE,
      'Booking cannot be completed',
    );
  }

  // Read the final state to return the complete DTO with all timestamps
  const finalBooking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_SELECT,
  });

  // Audit log — fire and forget (logAction never throws)
  void logAction({
    action: 'BOOKING_COMPLETED',
    actorUserId: userId,
    bookingId,
    workerId: finalBooking?.workerId,
    summary: `Booking ${bookingId} marked as completed by client ${userId}`,
    metadata: { previousStatus: 'CONFIRMED', newStatus: 'COMPLETED' },
  });

  return toBookingDto(finalBooking!);
}
