/**
 * Worker service layer — business logic for worker onboarding and approval.
 *
 * Routes are thin: they parse, authorize, and call these functions.
 * All Prisma access and state-transition rules live here.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { normalizePakistaniPhone } from '../lib/phone';
import { logAction } from './auditService';
import { translateWorkerPhoneConflict } from '../lib/prismaErrors';
import type { WorkerDTO } from '../types';

// --- DTO mapping ------------------------------------------------------------

/** Map a Prisma WorkerProfile row to a safe DTO. */
function toDTO(worker: {
  id: string;
  name: string;
  phone: string;
  status: string;
  suspensionReason: string | null;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): WorkerDTO {
  return {
    id: worker.id,
    name: worker.name,
    phone: worker.phone,
    status: worker.status as WorkerDTO['status'],
    suspensionReason: worker.suspensionReason,
    agentId: worker.agentId,
    createdAt: worker.createdAt.toISOString(),
    updatedAt: worker.updatedAt.toISOString(),
  };
}

// --- Create -----------------------------------------------------------------

export interface CreateWorkerInput {
  name: string;
  phone: string;
  agentId: string;
  // Week 3 optional fields
  cnicNumber?: string | null;
  referenceName?: string | null;
  referencePhone?: string | null;
  identityChecked?: boolean;
  phoneConfirmed?: boolean;
  backgroundChecked?: boolean;
  skillAssessed?: boolean;
  categoryIds?: string[];
  serviceAreaIds?: string[];
}

/**
 * Create a new worker profile in `PENDING_APPROVAL` status.
 *
 * - Normalizes and validates the phone number (Pakistani format).
 * - Pre-checks for duplicate phone to give a fast, clean 409 (UX).
 * - The DB unique constraint is the final concurrency-safe protection.
 *   If a concurrent insert wins the race, Prisma throws P2002 which
 *   we translate into a 409 WORKER_PHONE_ALREADY_EXISTS.
 * - Does not require a `userId` — the worker is not a platform user yet.
 * - Records the onboarding agent.
 * - Week 3: optionally sets CNIC, reference, verification fields, and
 *   associates categories/areas atomically in a single transaction.
 *   Status is always PENDING_APPROVAL — callers cannot set it.
 */
export async function createWorker(input: CreateWorkerInput): Promise<WorkerDTO> {
  const phone = normalizePakistaniPhone(input.phone);

  // Pre-check for duplicate phone — improves UX with a fast 409
  // but does NOT guarantee correctness under concurrent requests.
  const existing = await prisma.workerProfile.findFirst({
    where: { phone },
    select: { id: true },
  });
  if (existing) {
    throw errors.conflict(
      ErrorCode.WORKER_DUPLICATE_PHONE,
      'A worker with this phone number already exists',
    );
  }

  // Verify referenced categories exist (before the transaction)
  if (input.categoryIds !== undefined && input.categoryIds.length > 0) {
    const existingCats = await prisma.category.findMany({
      where: { id: { in: input.categoryIds } },
      select: { id: true },
    });
    if (existingCats.length !== new Set(input.categoryIds).size) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'One or more category IDs not found');
    }
  }

  // Verify referenced areas exist (before the transaction)
  if (input.serviceAreaIds !== undefined && input.serviceAreaIds.length > 0) {
    const existingAreas = await prisma.area.findMany({
      where: { id: { in: input.serviceAreaIds } },
      select: { id: true },
    });
    if (existingAreas.length !== new Set(input.serviceAreaIds).size) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'One or more service-area IDs not found');
    }
  }

  // Build the create data — status is always PENDING_APPROVAL
  const createData: Record<string, unknown> = {
    name: input.name,
    phone,
    status: 'PENDING_APPROVAL',
    agentId: input.agentId,
  };

  if (input.cnicNumber !== undefined) createData.cnicNumber = input.cnicNumber;
  if (input.referenceName !== undefined) createData.referenceName = input.referenceName;
  if (input.referencePhone !== undefined) createData.referencePhone = input.referencePhone;
  if (input.identityChecked !== undefined) createData.identityChecked = input.identityChecked;
  if (input.phoneConfirmed !== undefined) createData.phoneConfirmed = input.phoneConfirmed;
  if (input.backgroundChecked !== undefined) createData.backgroundChecked = input.backgroundChecked;
  if (input.skillAssessed !== undefined) createData.skillAssessed = input.skillAssessed;

  // Category/area associations
  if (input.categoryIds !== undefined && input.categoryIds.length > 0) {
    createData.categories = {
      create: [...new Set(input.categoryIds)].map((categoryId) => ({ categoryId })),
    };
  }
  if (input.serviceAreaIds !== undefined && input.serviceAreaIds.length > 0) {
    createData.serviceAreas = {
      create: [...new Set(input.serviceAreaIds)].map((areaId) => ({ areaId })),
    };
  }

  // The DB unique constraint is the source of truth.
  // If a concurrent request inserts the same phone between our
  // findUnique and create, Prisma throws P2002 — translate it.
  try {
    const worker = await prisma.workerProfile.create({
      data: createData as never,
    });

    return toDTO(worker);
  } catch (err) {
    const conflict = translateWorkerPhoneConflict(err);
    if (conflict) {
      throw conflict;
    }
    // Unknown error — let it propagate to the centralized error middleware.
    throw err;
  }
}

// --- Verify / transition ----------------------------------------------------

/** Allowed state transitions. */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING_APPROVAL: ['APPROVED', 'SUSPENDED'],
  APPROVED: ['SUSPENDED'],
  SUSPENDED: [], // no re-activation in Week 2
};

export interface VerifyWorkerInput {
  workerId: string;
  status: 'APPROVED' | 'SUSPENDED';
  reason?: string;
  actorUserId?: string;
}

/**
 * Approve or suspend a worker.
 *
 * - Returns 404 if the worker does not exist.
 * - Returns 422 for invalid state transitions.
 * - Uses a transaction because suspension writes both `status` and
 *   `suspensionReason`.
 */
export async function verifyWorker(input: VerifyWorkerInput): Promise<WorkerDTO> {
  const current = await prisma.workerProfile.findUnique({
    where: { id: input.workerId },
    select: { id: true, status: true },
  });

  if (!current) {
    throw errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker was not found');
  }

  const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(input.status)) {
    throw errors.unprocessable(
      ErrorCode.WORKER_INVALID_TRANSITION,
      `Cannot transition from ${current.status} to ${input.status}`,
    );
  }

  const worker = await prisma.$transaction(async (tx) => {
    return tx.workerProfile.update({
      where: { id: input.workerId },
      data: {
        status: input.status,
        suspensionReason:
          input.status === 'SUSPENDED' ? (input.reason ?? null) : null,
      },
    });
  });

  // Audit log — fire and forget (logAction never throws)
  if (input.actorUserId) {
    void logAction({
      action: 'WORKER_STATUS_CHANGED',
      actorUserId: input.actorUserId,
      workerId: input.workerId,
      summary: `Worker ${input.workerId} status changed to ${input.status}`,
      metadata: {
        previousStatus: current.status,
        newStatus: input.status,
        reason: input.reason ?? null,
      },
    });
  }

  return toDTO(worker);
}
