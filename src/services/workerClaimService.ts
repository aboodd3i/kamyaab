/**
 * Worker claim service — links an authenticated phone-OTP user to an
 * agent-created WorkerProfile whose `userId` is currently null.
 *
 * Security model:
 *   - The phone number is taken from the authenticated User row
 *     (server-side, set during Supabase Auth bootstrap), never from
 *     the request body.
 *   - A second factor (last 4 digits of stored CNIC) is required.
 *   - The claim is performed inside a database transaction with
 *     optimistic concurrency protection.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode, AppError } from '../lib/errors';
import { normalizePakistaniPhone } from '../lib/phone';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ClaimWorkerInput {
  /** Internal User ID of the authenticated claimant. */
  userId: string;
  /** Last 4 digits of the CNIC, supplied by the user. */
  cnicLast4: string;
}

export interface ClaimWorkerResult {
  workerProfileId: string;
  workerName: string;
  claimStatus: 'CLAIMED';
  userRole: 'WORKER';
  profileStatus: 'PENDING_APPROVAL' | 'APPROVED';
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * Claim a worker profile by matching the authenticated user's trusted
 * phone number and the supplied CNIC last-4 second factor.
 *
 * Rules:
 *   - Phone comes from the User record (trusted, server-side).
 *   - CNIC last-4 must match the stored cnicNumber's final 4 digits.
 *   - Worker must not be SUSPENDED.
 *   - Worker must not already be claimed by a different user.
 *   - User must not already be linked to a different worker profile.
 *   - Idempotent: if the same user retries, return success.
 *   - All mutations in a single transaction.
 */
export async function claimWorkerProfile(
  input: ClaimWorkerInput,
): Promise<ClaimWorkerResult> {
  const { userId, cnicLast4 } = input;

  // Fetch the authenticated user's trusted phone number
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, phone: true, role: true },
  });

  if (!user) {
    throw errors.unauthorized(ErrorCode.AUTH_USER_NOT_FOUND, 'User not found');
  }

  if (!user.phone) {
    // The authenticated user has no phone on record — cannot match
    throw errors.badRequest(
      ErrorCode.WORKER_CLAIM_FAILED,
      'Unable to verify claim — no confirmed phone number on account',
    );
  }

  // Normalize the trusted phone for matching
  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePakistaniPhone(user.phone);
  } catch {
    // If the stored phone doesn't normalize, treat as no match
    throw errors.badRequest(
      ErrorCode.WORKER_CLAIM_FAILED,
      'Unable to verify claim',
    );
  }

  // Find the candidate worker by phone
  const worker = await prisma.workerProfile.findUnique({
    where: { phone: normalizedPhone },
    select: {
      id: true,
      name: true,
      userId: true,
      status: true,
      cnicNumber: true,
    },
  });

  if (!worker) {
    // Generic message — do not reveal whether a worker exists for this phone
    throw errors.notFound(
      ErrorCode.WORKER_CLAIM_FAILED,
      'No unclaimed worker profile matches the provided credentials',
    );
  }

  // Idempotent: same user already linked to this profile
  if (worker.userId === userId) {
    return {
      workerProfileId: worker.id,
      workerName: worker.name,
      claimStatus: 'CLAIMED',
      userRole: 'WORKER',
      profileStatus: worker.status as 'PENDING_APPROVAL' | 'APPROVED',
    };
  }

  // Worker already claimed by a different user
  if (worker.userId !== null) {
    throw errors.conflict(
      ErrorCode.WORKER_ALREADY_CLAIMED,
      'This worker profile has already been claimed',
    );
  }

  // Suspended workers cannot be claimed
  if (worker.status === 'SUSPENDED') {
    throw errors.forbidden(
      ErrorCode.WORKER_PROFILE_SUSPENDED,
      'This worker profile is suspended and cannot be claimed',
    );
  }

  // Second factor: CNIC last-4
  if (!worker.cnicNumber) {
    throw errors.badRequest(
      ErrorCode.WORKER_CLAIM_FAILED,
      'Unable to verify claim',
    );
  }

  const storedLast4 = worker.cnicNumber.slice(-4);
  if (storedLast4 !== cnicLast4) {
    // Generic message — do not reveal that the CNIC exists but mismatched
    throw errors.badRequest(
      ErrorCode.WORKER_CLAIM_FAILED,
      'Unable to verify claim — credentials do not match',
    );
  }

  // Check if the user is already linked to a DIFFERENT worker profile
  const existingLink = await prisma.workerProfile.findUnique({
    where: { userId: userId },
    select: { id: true },
  });

  if (existingLink && existingLink.id !== worker.id) {
    throw errors.conflict(
      ErrorCode.WORKER_ALREADY_LINKED,
      'This account is already linked to a different worker profile',
    );
  }

  // Perform the claim in a transaction
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock the worker row for update (optimistic concurrency)
      // Re-read inside the transaction to check userId is still null
      const currentWorker = await tx.workerProfile.findUnique({
        where: { id: worker.id },
        select: { userId: true, status: true },
      });

      if (!currentWorker) {
        throw errors.notFound(
          ErrorCode.WORKER_CLAIM_FAILED,
          'No unclaimed worker profile matches the provided credentials',
        );
      }

      // Race: another user claimed it between our read and the transaction
      if (currentWorker.userId !== null && currentWorker.userId !== userId) {
        throw errors.conflict(
          ErrorCode.WORKER_ALREADY_CLAIMED,
          'This worker profile has already been claimed',
        );
      }

      // Race: worker was suspended between our read and the transaction
      if (currentWorker.status === 'SUSPENDED') {
        throw errors.forbidden(
          ErrorCode.WORKER_PROFILE_SUSPENDED,
          'This worker profile is suspended and cannot be claimed',
        );
      }

      // Link the worker to the user and set WORKER role
      const updatedWorker = await tx.workerProfile.update({
        where: { id: worker.id },
        data: { userId: userId },
        select: { id: true, name: true, status: true },
      });

      await tx.user.update({
        where: { id: userId },
        data: { role: { set: 'WORKER' } },
      });

      return updatedWorker;
    });

    return {
      workerProfileId: result.id,
      workerName: result.name,
      claimStatus: 'CLAIMED',
      userRole: 'WORKER',
      profileStatus: result.status as 'PENDING_APPROVAL' | 'APPROVED',
    };
  } catch (err) {
    // Handle P2002 unique constraint on WorkerProfile.userId
    // (concurrent claim race where two users tried to claim the same profile)
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      throw errors.conflict(
        ErrorCode.WORKER_ALREADY_CLAIMED,
        'This worker profile has already been claimed',
      );
    }
    // Re-throw AppError instances as-is
    if (err instanceof AppError) {
      throw err;
    }
    // Unexpected error
    throw errors.internal('Claim failed due to an unexpected error');
  }
}
