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
import { logAction } from './auditService';
import type { StorageAdapter } from './storageAdapter';
import { randomUUID } from 'crypto';
import {
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_FILE_SIZE,
  ACCEPTED_EVIDENCE_MIME_TYPES,
  EVIDENCE_MIME_EXTENSIONS,
} from '../lib/complaintValidation';

// ─── Types ─────────────────────────────────────────────────────────────────

export type ComplaintStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

/** Fields selected from Prisma for the DTO. */
const COMPLAINT_SELECT = {
  id: true,
  bookingId: true,
  filedByUserId: true,
  reason: true,
  status: true,
  evidenceFilePaths: true,
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

  // Audit log — fire and forget (logAction never throws)
  void logAction({
    action: 'COMPLAINT_FILED',
    actorUserId: filedByUserId,
    bookingId,
    complaintId: complaint.id,
    summary: `Complaint filed on booking ${bookingId}`,
    metadata: { reason, complaintId: complaint.id },
  });

  return toComplaintDto(complaint);
}

// ─── Create Complaint with Evidence Files ──────────────────────────────────

export interface EvidenceFile {
  buffer: Buffer;
  mimetype: string;
}

export interface UploadComplaintEvidenceInput {
  bookingId: string;
  filedByUserId: string;
  reason: string;
  evidenceFiles?: EvidenceFile[];
  storage: StorageAdapter;
}

/**
 * File a complaint against a booking, optionally with evidence files.
 *
 * Uploads evidence files to private Supabase Storage, then creates the
 * Complaint record with the storage paths. If any upload fails, all
 * successfully uploaded objects are removed (compensation).
 *
 * Handles both with and without files — single code path.
 */
export async function uploadComplaintEvidence(
  input: UploadComplaintEvidenceInput,
): Promise<ComplaintDto> {
  const { bookingId, filedByUserId, reason, storage } = input;
  const evidenceFiles = input.evidenceFiles ?? [];

  // Verify the booking exists
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true },
  });

  if (!booking) {
    throw errors.notFound(ErrorCode.BOOKING_NOT_FOUND, 'Booking not found');
  }

  // Validate evidence files
  if (evidenceFiles.length > MAX_EVIDENCE_FILES) {
    throw errors.badRequest(
      ErrorCode.VALIDATION_ERROR,
      `Maximum ${MAX_EVIDENCE_FILES} evidence files allowed`,
    );
  }

  for (let i = 0; i < evidenceFiles.length; i++) {
    const file = evidenceFiles[i];
    if (!ACCEPTED_EVIDENCE_MIME_TYPES.has(file.mimetype)) {
      throw errors.badRequest(
        ErrorCode.VALIDATION_ERROR,
        `Unsupported file type for evidence file ${i + 1}`,
      );
    }
    if (file.buffer.length > MAX_EVIDENCE_FILE_SIZE) {
      throw errors.badRequest(
        ErrorCode.VALIDATION_ERROR,
        `Evidence file ${i + 1} exceeds maximum size of 5 MiB`,
      );
    }
  }

  // Upload evidence files to storage
  const uploadedPaths: string[] = [];
  const complaintId = randomUUID();

  if (evidenceFiles.length > 0) {
    try {
      for (const file of evidenceFiles) {
        const ext = EVIDENCE_MIME_EXTENSIONS[file.mimetype];
        const path = `complaints/${complaintId}/evidence/${randomUUID()}.${ext}`;
        await storage.uploadPrivateObject(path, file.buffer, file.mimetype);
        uploadedPaths.push(path);
      }
    } catch (uploadErr) {
      // Compensation: remove any successfully uploaded objects
      for (const path of uploadedPaths) {
        try {
          await storage.removePrivateObject(path);
        } catch {
          console.error('Failed to clean up uploaded evidence file after upload failure');
        }
      }
      throw errors.internal('Evidence file upload failed');
    }
  }

  // Create the complaint record with evidence paths
  let complaint;
  try {
    complaint = await prisma.complaint.create({
      data: {
        id: complaintId,
        bookingId,
        filedByUserId,
        reason,
        evidenceFilePaths: uploadedPaths,
      },
      select: COMPLAINT_SELECT,
    });
  } catch (dbErr) {
    // Compensation: remove uploaded files if DB write fails
    for (const path of uploadedPaths) {
      try {
        await storage.removePrivateObject(path);
      } catch {
        console.error('Failed to clean up uploaded evidence file after DB failure');
      }
    }
    throw dbErr;
  }

  // Audit log — fire and forget (logAction never throws)
  void logAction({
    action: 'COMPLAINT_FILED',
    actorUserId: filedByUserId,
    bookingId,
    complaintId: complaint.id,
    summary: `Complaint filed on booking ${bookingId} with ${uploadedPaths.length} evidence file(s)`,
    metadata: { reason, complaintId: complaint.id, evidenceFileCount: uploadedPaths.length },
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

  // Audit log — fire and forget (logAction never throws)
  void logAction({
    action: 'COMPLAINT_RESOLVED',
    actorUserId: resolvedByUserId,
    complaintId,
    bookingId: updated.bookingId,
    summary: `Complaint ${complaintId} ${status.toLowerCase()}`,
    metadata: { status, resolution: resolution ?? null, complaintId },
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
