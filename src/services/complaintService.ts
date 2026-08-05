/**
 * Complaint service (Week 6) — internal reusable methods for complaint operations.
 *
 * This module provides the service-layer logic for the complaint system.
 * No Express handlers or routes are registered here — routes remain thin.
 *
 * createComplaint: any authenticated user can file a complaint against a booking.
 * resolveComplaint: only admins can resolve or dismiss complaints.
 * findComplaint / listComplaints: read-only lookups.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { toComplaintDto, type ComplaintDto } from '../lib/complaintDto';

// ─── Types ─────────────────────────────────────────────────────────────────

export type ComplaintStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

/** Fields selected from Prisma for the DTO. */
const COMPLAINT_SELECT = {
  id: true,
  bookingId: true,
  filedByUserId: true,
  reason: true,
  status: true,
  resolvedByUserId: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ─── Create Complaint ──────────────────────────────────────────────────────

/**
 * File a complaint against a booking.
 *
 * Authorization:
 *   - Any authenticated user may file a complaint.
 *   - The booking must exist.
 *
 * @param bookingId     The booking to complain about.
 * @param filedByUserId The authenticated user's internal User ID (trusted, server-side).
 * @param reason        Free-text reason (validated by Zod at the route layer, max 2000 chars).
 * @returns Safe ComplaintDto — never a raw Prisma object.
 */
export async function createComplaint(
  bookingId: string,
  filedByUserId: string,
  reason: string,
): Promise<ComplaintDto> {
  // Verify the booking exists
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true },
  });

  if (!booking) {
    throw errors.notFound(ErrorCode.BOOKING_NOT_FOUND, 'Booking not found');
  }

  const complaint = await prisma.complaint.create({
    data: {
      bookingId,
      filedByUserId,
      reason,
    },
    select: COMPLAINT_SELECT,
  });

  return toComplaintDto(complaint);
}

// ─── Resolve Complaint ─────────────────────────────────────────────────────

/**
 * Resolve or dismiss a complaint as an admin.
 *
 * Authorization:
 *   - The caller must be an ADMIN (enforced at the route layer).
 *   - The complaint must exist.
 *   - The complaint must be in OPEN status.
 *
 * @param complaintId      The complaint to resolve.
 * @param resolvedByUserId The admin's internal User ID (trusted, server-side).
 * @param status           'RESOLVED' or 'DISMISSED'.
 * @param resolution       Optional admin resolution note (max 2000 chars).
 * @returns Safe ComplaintDto — never a raw Prisma object.
 */
export async function resolveComplaint(
  complaintId: string,
  resolvedByUserId: string,
  status: 'RESOLVED' | 'DISMISSED',
  resolution?: string | null,
): Promise<ComplaintDto> {
  const complaint = await prisma.complaint.findUnique({
    where: { id: complaintId },
    select: { ...COMPLAINT_SELECT },
  });

  if (!complaint) {
    throw errors.notFound(ErrorCode.COMPLAINT_NOT_FOUND, 'Complaint not found');
  }

  if (complaint.status !== 'OPEN') {
    throw errors.conflict(
      ErrorCode.COMPLAINT_ALREADY_RESOLVED,
      'Complaint has already been resolved or dismissed',
    );
  }

  const updated = await prisma.complaint.update({
    where: { id: complaintId },
    data: {
      status,
      resolvedByUserId,
      resolution: resolution ?? null,
      resolvedAt: new Date(),
    },
    select: COMPLAINT_SELECT,
  });

  return toComplaintDto(updated);
}

// ─── Read Methods ──────────────────────────────────────────────────────────

/**
 * Find a single complaint by ID.
 *
 * Returns a safe ComplaintDto or throws COMPLAINT_NOT_FOUND.
 *
 * @param complaintId The complaint to look up.
 */
export async function findComplaint(complaintId: string): Promise<ComplaintDto> {
  const complaint = await prisma.complaint.findUnique({
    where: { id: complaintId },
    select: COMPLAINT_SELECT,
  });

  if (!complaint) {
    throw errors.notFound(ErrorCode.COMPLAINT_NOT_FOUND, 'Complaint not found');
  }

  return toComplaintDto(complaint);
}

/**
 * List complaints, optionally filtered by status.
 *
 * Returns an array of safe ComplaintDto objects.
 * Ordered by createdAt descending (newest first).
 *
 * @param status Optional status filter ('OPEN', 'RESOLVED', 'DISMISSED').
 * @param limit  Maximum number of results (default 50, max 100).
 */
export async function listComplaints(
  status?: ComplaintStatus,
  limit = 50,
): Promise<ComplaintDto[]> {
  const complaints = await prisma.complaint.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    select: COMPLAINT_SELECT,
  });

  return complaints.map(toComplaintDto);
}
