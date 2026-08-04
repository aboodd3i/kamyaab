/**
 * Week 3 worker service — profile update, category/area assignment,
 * and CNIC document upload.
 *
 * All association changes use a single Prisma transaction.
 * Reference-verification audit fields are server-derived.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { normalizePakistaniPhone } from '../lib/phone';
import { randomUUID } from 'crypto';
import type { StorageAdapter } from './storageAdapter';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface UpdateWorkerInput {
  workerId: string;
  callerId: string;
  callerRole: 'AGENT' | 'ADMIN';
  name?: string;
  phone?: string;
  cnicNumber?: string | null;
  referenceName?: string | null;
  referencePhone?: string | null;
  referenceStatus?: 'UNVERIFIED' | 'CONTACTED' | 'CONFIRMED' | 'FAILED';
  identityChecked?: boolean;
  phoneConfirmed?: boolean;
  backgroundChecked?: boolean;
  skillAssessed?: boolean;
  categoryIds?: string[];
  serviceAreaIds?: string[];
}

export interface UpdateWorkerResult {
  id: string;
  name: string;
  status: string;
  cnicRecorded: boolean;
  cnicFrontUploaded: boolean;
  cnicBackUploaded: boolean;
  identityChecked: boolean;
  phoneConfirmed: boolean;
  referenceStatus: string;
  backgroundChecked: boolean;
  skillAssessed: boolean;
  categories: { id: string; name: string }[];
  serviceAreas: { id: string; name: string }[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Normalize and deduplicate ID arrays. Throws on invalid input. */
function normalizeIdArray(ids: unknown, fieldName: string): string[] {
  if (ids === undefined) return undefined as never;
  if (!Array.isArray(ids)) {
    throw errors.badRequest(ErrorCode.VALIDATION_ERROR, `${fieldName} must be an array`);
  }
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, `${fieldName} contains invalid IDs`);
    }
  }
  // Deduplicate
  return [...new Set(ids as string[])];
}

/**
 * Determine reference-verification audit fields based on status transition.
 *
 * - CONFIRMED: set verifiedById to caller, verifiedAt to now
 * - Unverified/reset states: clear audit fields
 */
function resolveReferenceAuditFields(
  referenceStatus: 'UNVERIFIED' | 'CONTACTED' | 'CONFIRMED' | 'FAILED',
  callerId: string,
): {
  referenceVerifiedById: string | null;
  referenceVerifiedAt: Date | null;
} {
  if (referenceStatus === 'CONFIRMED') {
    return {
      referenceVerifiedById: callerId,
      referenceVerifiedAt: new Date(),
    };
  }
  // UNVERIFIED, CONTACTED, FAILED — clear audit fields
  return {
    referenceVerifiedById: null,
    referenceVerifiedAt: null,
  };
}

// ─── Update Worker ─────────────────────────────────────────────────────────

export async function updateWorker(input: UpdateWorkerInput): Promise<UpdateWorkerResult> {
  // Fetch the worker and check authorization
  const worker = await prisma.workerProfile.findUnique({
    where: { id: input.workerId },
    select: {
      id: true,
      name: true,
      status: true,
      agentId: true,
      cnicNumber: true,
      cnicFrontPath: true,
      cnicBackPath: true,
      identityChecked: true,
      phoneConfirmed: true,
      referenceStatus: true,
      backgroundChecked: true,
      skillAssessed: true,
    },
  });

  if (!worker) {
    throw errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker was not found');
  }

  // Authorization: ADMIN can update any; AGENT only their own
  if (input.callerRole === 'AGENT' && worker.agentId !== input.callerId) {
    // Use 404 for anti-enumeration — don't reveal the worker exists
    throw errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker was not found');
  }

  // Normalize inputs
  let phone: string | undefined;
  if (input.phone !== undefined) {
    phone = normalizePakistaniPhone(input.phone);
  }

  const categoryIds = input.categoryIds !== undefined
    ? normalizeIdArray(input.categoryIds, 'categoryIds')
    : undefined;
  const serviceAreaIds = input.serviceAreaIds !== undefined
    ? normalizeIdArray(input.serviceAreaIds, 'serviceAreaIds')
    : undefined;

  // Verify referenced categories exist
  if (categoryIds !== undefined && categoryIds.length > 0) {
    const existingCats = await prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true },
    });
    if (existingCats.length !== categoryIds.length) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'One or more category IDs not found');
    }
  }

  // Verify referenced areas exist
  if (serviceAreaIds !== undefined && serviceAreaIds.length > 0) {
    const existingAreas = await prisma.area.findMany({
      where: { id: { in: serviceAreaIds } },
      select: { id: true },
    });
    if (existingAreas.length !== serviceAreaIds.length) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'One or more service-area IDs not found');
    }
  }

  // Build the update data
  const updateData: Record<string, unknown> = {};

  if (input.name !== undefined) updateData.name = input.name;
  if (phone !== undefined) updateData.phone = phone;
  if (input.cnicNumber !== undefined) updateData.cnicNumber = input.cnicNumber;
  if (input.referenceName !== undefined) updateData.referenceName = input.referenceName;
  if (input.referencePhone !== undefined) updateData.referencePhone = input.referencePhone;
  if (input.identityChecked !== undefined) updateData.identityChecked = input.identityChecked;
  if (input.phoneConfirmed !== undefined) updateData.phoneConfirmed = input.phoneConfirmed;
  if (input.backgroundChecked !== undefined) updateData.backgroundChecked = input.backgroundChecked;
  if (input.skillAssessed !== undefined) updateData.skillAssessed = input.skillAssessed;

  // Reference status with server-derived audit fields
  if (input.referenceStatus !== undefined) {
    updateData.referenceStatus = input.referenceStatus;
    const audit = resolveReferenceAuditFields(input.referenceStatus, input.callerId);
    updateData.referenceVerifiedById = audit.referenceVerifiedById;
    updateData.referenceVerifiedAt = audit.referenceVerifiedAt;
  }

  // Category/area assignment within the same transaction
  if (categoryIds !== undefined) {
    updateData.categories = {
      deleteMany: {},
      create: categoryIds.map((categoryId) => ({ categoryId })),
    };
  }
  if (serviceAreaIds !== undefined) {
    updateData.serviceAreas = {
      deleteMany: {},
      create: serviceAreaIds.map((areaId) => ({ areaId })),
    };
  }

  // Execute in a single transaction
  const updated = await prisma.$transaction(async (tx) => {
    return tx.workerProfile.update({
      where: { id: input.workerId },
      data: updateData,
      select: {
        id: true,
        name: true,
        status: true,
        cnicNumber: true,
        cnicFrontPath: true,
        cnicBackPath: true,
        identityChecked: true,
        phoneConfirmed: true,
        referenceStatus: true,
        backgroundChecked: true,
        skillAssessed: true,
        categories: {
          select: { category: { select: { id: true, name: true } } },
        },
        serviceAreas: {
          select: { area: { select: { id: true, name: true } } },
        },
      },
    });
  });

  return {
    id: updated.id,
    name: updated.name,
    status: updated.status,
    cnicRecorded: updated.cnicNumber !== null,
    cnicFrontUploaded: updated.cnicFrontPath !== null,
    cnicBackUploaded: updated.cnicBackPath !== null,
    identityChecked: updated.identityChecked,
    phoneConfirmed: updated.phoneConfirmed,
    referenceStatus: updated.referenceStatus,
    backgroundChecked: updated.backgroundChecked,
    skillAssessed: updated.skillAssessed,
    categories: updated.categories.map((c) => c.category),
    serviceAreas: updated.serviceAreas.map((a) => a.area),
  };
}

// ─── CNIC Document Upload ──────────────────────────────────────────────────

export const MAX_CNIC_FILE_SIZE = 5 * 1024 * 1024; // 5 MiB

export const ACCEPTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** MIME type → file extension mapping */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface CnicUploadInput {
  workerId: string;
  callerId: string;
  callerRole: 'AGENT' | 'ADMIN';
  cnicFront?: { buffer: Buffer; mimetype: string };
  cnicBack?: { buffer: Buffer; mimetype: string };
  storage: StorageAdapter;
}

export interface CnicUploadResult {
  workerId: string;
  cnicFrontUploaded: boolean;
  cnicBackUploaded: boolean;
}

/**
 * Upload CNIC documents to private storage and update the worker record.
 *
 * Compensation strategy:
 * 1. Validate authorization and request metadata before uploading.
 * 2. Upload the requested new object(s).
 * 3. Update cnicFrontPath/cnicBackPath in PostgreSQL.
 * 4. If an upload fails after another succeeded, remove the newly uploaded object.
 * 5. If the database update fails, remove every newly uploaded object.
 * 6. Do not delete old objects before new paths are committed.
 * 7. After DB success, attempt to remove replaced old objects.
 * 8. Old-object cleanup failure does not roll back the DB update.
 */
export async function uploadCnicDocuments(input: CnicUploadInput): Promise<CnicUploadResult> {
  const { workerId, callerId, callerRole, storage } = input;

  // Validate at least one file is present
  if (!input.cnicFront && !input.cnicBack) {
    throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'At least one CNIC document must be provided');
  }

  // Validate MIME types and sizes
  for (const [fieldName, file] of [['cnicFront', input.cnicFront], ['cnicBack', input.cnicBack]] as const) {
    if (file) {
      if (!ACCEPTED_MIME_TYPES.has(file.mimetype)) {
        throw errors.badRequest(ErrorCode.VALIDATION_ERROR, `Unsupported file type for ${fieldName}`);
      }
      if (file.buffer.length > MAX_CNIC_FILE_SIZE) {
        throw errors.badRequest(ErrorCode.VALIDATION_ERROR, `${fieldName} exceeds maximum size of 5 MiB`);
      }
    }
  }

  // Fetch the worker and check authorization
  const worker = await prisma.workerProfile.findUnique({
    where: { id: workerId },
    select: { id: true, agentId: true, cnicFrontPath: true, cnicBackPath: true },
  });

  if (!worker) {
    throw errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker was not found');
  }

  if (callerRole === 'AGENT' && worker.agentId !== callerId) {
    throw errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker was not found');
  }

  // Generate storage paths — no PII, no original filenames
  const uploadedPaths: string[] = [];
  let newFrontPath: string | null = null;
  let newBackPath: string | null = null;

  try {
    // Upload front
    if (input.cnicFront) {
      const ext = MIME_EXTENSIONS[input.cnicFront.mimetype];
      newFrontPath = `workers/${workerId}/cnic/front/${randomUUID()}.${ext}`;
      await storage.uploadPrivateObject(newFrontPath, input.cnicFront.buffer, input.cnicFront.mimetype);
      uploadedPaths.push(newFrontPath);
    }

    // Upload back
    if (input.cnicBack) {
      const ext = MIME_EXTENSIONS[input.cnicBack.mimetype];
      newBackPath = `workers/${workerId}/cnic/back/${randomUUID()}.${ext}`;
      await storage.uploadPrivateObject(newBackPath, input.cnicBack.buffer, input.cnicBack.mimetype);
      uploadedPaths.push(newBackPath);
    }
  } catch (uploadErr) {
    // Compensation: remove any successfully uploaded objects
    for (const path of uploadedPaths) {
      try {
        await storage.removePrivateObject(path);
      } catch {
        // Best-effort cleanup — log without path
        console.error('Failed to clean up uploaded CNIC object after upload failure');
      }
    }
    throw errors.internal('Document upload failed');
  }

  // Save old paths for post-success cleanup
  const oldFrontPath = worker.cnicFrontPath;
  const oldBackPath = worker.cnicBackPath;

  // Update database
  try {
    const updateData: Record<string, unknown> = {};
    if (newFrontPath !== null) updateData.cnicFrontPath = newFrontPath;
    if (newBackPath !== null) updateData.cnicBackPath = newBackPath;

    await prisma.workerProfile.update({
      where: { id: workerId },
      data: updateData,
    });
  } catch (dbErr) {
    // Compensation: remove all newly uploaded objects
    for (const path of uploadedPaths) {
      try {
        await storage.removePrivateObject(path);
      } catch {
        console.error('Failed to clean up uploaded CNIC object after DB failure');
      }
    }
    throw errors.internal('Failed to update worker document paths');
  }

  // Post-success: attempt to remove replaced old objects (best-effort)
  const oldPathsToRemove: string[] = [];
  if (newFrontPath !== null && oldFrontPath) oldPathsToRemove.push(oldFrontPath);
  if (newBackPath !== null && oldBackPath) oldPathsToRemove.push(oldBackPath);

  for (const path of oldPathsToRemove) {
    try {
      await storage.removePrivateObject(path);
    } catch {
      // Log without path — DB update already succeeded, don't roll back
      console.error('Failed to remove replaced CNIC object after successful update');
    }
  }

  return {
    workerId,
    cnicFrontUploaded: newFrontPath !== null,
    cnicBackUploaded: newBackPath !== null,
  };
}
