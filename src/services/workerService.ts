/**
 * Worker service layer — business logic for worker onboarding and approval.
 *
 * Routes are thin: they parse, authorize, and call these functions.
 * All Prisma access and state-transition rules live here.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { normalizePakistaniPhone } from '../lib/phone';
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
 */
export async function createWorker(input: CreateWorkerInput): Promise<WorkerDTO> {
  const phone = normalizePakistaniPhone(input.phone);

  // Pre-check for duplicate phone — improves UX with a fast 409
  // but does NOT guarantee correctness under concurrent requests.
  const existing = await prisma.workerProfile.findUnique({
    where: { phone },
    select: { id: true },
  });
  if (existing) {
    throw errors.conflict(
      ErrorCode.WORKER_DUPLICATE_PHONE,
      'A worker with this phone number already exists',
    );
  }

  // The DB unique constraint is the source of truth.
  // If a concurrent request inserts the same phone between our
  // findUnique and create, Prisma throws P2002 — translate it.
  try {
    const worker = await prisma.workerProfile.create({
      data: {
        name: input.name,
        phone,
        status: 'PENDING_APPROVAL',
        agentId: input.agentId,
      },
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

  return toDTO(worker);
}
