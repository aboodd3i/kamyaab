/**
 * Admin service — manual worker assignment to job requests.
 *
 * An ADMIN can manually assign a worker to a job request that is in
 * DRAFT, WORKER_CONTACTED, or MATCHING status. This creates a single
 * invitation and moves the job to WORKER_CONTACTED.
 *
 * This is useful when:
 * - No matching workers were found for an OPEN job
 * - The client needs help finding a worker
 * - An agent/admin wants to override the automatic matching
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { sendMockSms } from './mockSmsService';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ManualAssignInput {
  jobRequestId: string;
  workerId: string;
  adminId: string;
}

export interface ManualAssignResult {
  jobRequestId: string;
  workerId: string;
  workerName: string;
  invitationId: string;
  status: string;
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * Manually assign a worker to a job request.
 *
 * @throws 404 if job request or worker not found
 * @throws 400 if worker is not APPROVED
 * @throws 409 if job already has an accepted invitation / booking
 */
export async function manualAssign(input: ManualAssignInput): Promise<ManualAssignResult> {
  const { jobRequestId, workerId, adminId } = input;

  // Fetch the job request with category for SMS
  const jobRequest = await prisma.jobRequest.findUnique({
    where: { id: jobRequestId },
    select: {
      id: true,
      status: true,
      type: true,
      categoryId: true,
      areaId: true,
      category: { select: { name: true } },
      client: {
        select: {
          user: { select: { phone: true } },
        },
      },
    },
  });

  if (!jobRequest) {
    throw errors.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Job request not found');
  }

  // Cannot assign to a job that's already accepted or has a booking
  if (['ACCEPTED', 'COMPLETED', 'CANCELLED'].includes(jobRequest.status)) {
    throw errors.conflict(ErrorCode.INVALID_STATE_TRANSITION, `Cannot assign worker to a job in ${jobRequest.status} status`);
  }

  // Fetch and validate the worker
  const worker = await prisma.workerProfile.findUnique({
    where: { id: workerId },
    select: {
      id: true,
      name: true,
      status: true,
      categories: { select: { categoryId: true } },
      serviceAreas: { select: { areaId: true } },
    },
  });

  if (!worker) {
    throw errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker not found');
  }

  if (worker.status !== 'APPROVED') {
    throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Only approved workers can be assigned');
  }

  // Check if an invitation already exists for this worker + job
  const existingInvitation = await prisma.jobInvitation.findUnique({
    where: {
      jobRequestId_workerId: { jobRequestId, workerId },
    },
    select: { id: true, status: true },
  });

  if (existingInvitation && existingInvitation.status === 'PENDING') {
    throw errors.conflict(ErrorCode.INVALID_STATE_TRANSITION, 'A pending invitation already exists for this worker');
  }

  // Transaction: create/update invitation + update job status
  const result = await prisma.$transaction(async (tx) => {
    // Expire any existing PENDING invitations for this job (OPEN jobs)
    await tx.jobInvitation.updateMany({
      where: {
        jobRequestId,
        status: 'PENDING',
      },
      data: {
        status: 'EXPIRED',
        respondedAt: new Date(),
      },
    });

    // Create a new invitation (or recreate if previously rejected/expired)
    const invitation = await tx.jobInvitation.upsert({
      where: {
        jobRequestId_workerId: { jobRequestId, workerId },
      },
      create: {
        jobRequestId,
        workerId,
        status: 'PENDING',
      },
      update: {
        status: 'PENDING',
        respondedAt: null,
      },
    });

    // Update job request status
    await tx.jobRequest.update({
      where: { id: jobRequestId },
      data: {
        status: 'WORKER_CONTACTED',
        targetWorkerId: workerId,
      },
    });

    return invitation;
  });

  // Send mock SMS to the assigned worker
  await sendMockSms(
    '0000', // Worker phone not directly available; mock SMS logs to console
    `Kamyaab: You have been assigned to a ${jobRequest.category.name} job by an admin. Please check your pending invitations.`,
  );

  return {
    jobRequestId,
    workerId,
    workerName: worker.name,
    invitationId: result.id,
    status: 'WORKER_CONTACTED',
  };
}
