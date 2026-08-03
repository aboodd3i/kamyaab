/**
 * Job Request service — handles the lifecycle of job requests (Flow A: Specific Worker).
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import { sendMockSms } from './mockSmsService';
import { toMyJobItem } from '../lib/myJobsDto';
import type {
  CreateJobRequestInput,
  UpdateJobRequestInput,
  SubmitJobRequestInput,
} from '../types';

/** Create a new job request draft. */
export async function createDraft(userId: string, input: CreateJobRequestInput) {
  const clientProfile = await prisma.clientProfile.findUnique({ where: { userId } });
  if (!clientProfile) throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Client profile not found');

  const [category, area] = await Promise.all([
    prisma.category.findUnique({ where: { id: input.categoryId } }),
    prisma.area.findUnique({ where: { id: input.areaId } }),
  ]);

  if (!category) throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid category ID');
  if (!area) throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid area ID');

  const draft = await prisma.jobRequest.create({
    data: {
      clientId: clientProfile.id,
      categoryId: input.categoryId,
      areaId: input.areaId,
      description: input.description,
      urgency: input.urgency,
      budget: input.budget,
      type: input.type,
      status: 'DRAFT',
    },
    include: {
      category: { select: { id: true, name: true } },
      area: { select: { id: true, name: true } },
    },
  });

  return draft;
}

/** Update an existing draft. */
export async function updateDraft(
  jobRequestId: string,
  userId: string,
  input: UpdateJobRequestInput
) {
  const clientProfile = await prisma.clientProfile.findUnique({ where: { userId } });
  if (!clientProfile) throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Client profile not found');

  const job = await prisma.jobRequest.findUnique({ where: { id: jobRequestId } });

  if (!job) {
    throw errors.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Job request not found');
  }
  if (job.clientId !== clientProfile.id) {
    throw errors.forbidden(ErrorCode.AUTH_FORBIDDEN, 'You can only update your own job requests');
  }
  if (job.status !== 'DRAFT') {
    throw errors.badRequest(ErrorCode.INVALID_STATE_TRANSITION, 'Only draft job requests can be updated');
  }

  // Validate related entities if they are being updated
  if (input.categoryId) {
    const cat = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!cat) throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid category ID');
  }
  if (input.areaId) {
    const area = await prisma.area.findUnique({ where: { id: input.areaId } });
    if (!area) throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid area ID');
  }

  const updated = await prisma.jobRequest.update({
    where: { id: jobRequestId },
    data: input,
    include: {
      category: { select: { id: true, name: true } },
      area: { select: { id: true, name: true } },
    },
  });

  return updated;
}

/**
 * Submit a job request targeting a specific worker.
 * Creates an invitation and notifies the worker via Mock SMS.
 */
export async function submitJobRequest(
  jobRequestId: string,
  userId: string,
  input: SubmitJobRequestInput
) {
  const clientProfile = await prisma.clientProfile.findUnique({ where: { userId } });
  if (!clientProfile) throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Client profile not found');

  const job = await prisma.jobRequest.findUnique({
    where: { id: jobRequestId },
    include: { client: { include: { user: true } } },
  });

  if (!job) {
    throw errors.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Job request not found');
  }
  if (job.clientId !== clientProfile.id) {
    throw errors.forbidden(ErrorCode.AUTH_FORBIDDEN, 'You can only submit your own job requests');
  }
  if (job.status !== 'DRAFT') {
    throw errors.badRequest(ErrorCode.INVALID_STATE_TRANSITION, 'Only draft job requests can be submitted');
  }

  // Week 4 only supports SPECIFIC_WORKER flow. OPEN requests are Week 5.
  if (job.type !== 'SPECIFIC_WORKER') {
    throw errors.badRequest(
      ErrorCode.INVALID_STATE_TRANSITION,
      'Only SPECIFIC_WORKER requests can be submitted in the current flow',
    );
  }

  // Validate target worker
  const worker = await prisma.workerProfile.findUnique({
    where: { id: input.targetWorkerId },
    include: {
      categories: true,
      serviceAreas: true,
    },
  });

  if (!worker) {
    throw errors.badRequest(ErrorCode.WORKER_NOT_FOUND, 'Target worker not found');
  }
  if (worker.status !== 'APPROVED') {
    throw errors.badRequest(ErrorCode.INVALID_STATE_TRANSITION, 'Target worker is not approved');
  }

  // Check if worker offers the requested category and serves the requested area
  const offersCategory = worker.categories.some((c) => c.categoryId === job.categoryId);
  const servesArea = worker.serviceAreas.some((a) => a.areaId === job.areaId);

  if (!offersCategory) {
    throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Worker does not offer services in the requested category');
  }
  if (!servesArea) {
    throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Worker does not serve the requested area');
  }

  // Execute in a transaction: update job request -> create invitation
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

  const submittedJob = await prisma.$transaction(async (tx) => {
    // 1. Update JobRequest
    const updatedJob = await tx.jobRequest.update({
      where: { id: jobRequestId },
      data: {
        status: 'WORKER_CONTACTED',
        targetWorkerId: worker.id,
        submittedAt: new Date(),
        expiresAt,
      },
      include: {
        category: { select: { id: true, name: true } },
        area: { select: { id: true, name: true } },
      },
    });

    // 2. Create Invitation
    await tx.jobInvitation.create({
      data: {
        jobRequestId: jobRequestId,
        workerId: worker.id,
        status: 'PENDING',
        smsSentAt: new Date(),
      },
    });

    return updatedJob;
  });

  // Trigger Mock SMS (outside transaction, non-blocking)
  const clientName = job.client?.name || 'A client';
  await sendMockSms(
    worker.phone,
    `Kamyaab: ${clientName} has invited you to a new ${submittedJob.category.name} job in ${submittedJob.area.name}. Log in to view details and accept within 24 hours!`
  );

  return submittedJob;
}

/** Get all job requests for a client, with contact-release gating. */
export async function getMyJobs(userId: string) {
  const clientProfile = await prisma.clientProfile.findUnique({ where: { userId } });
  if (!clientProfile) throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Client profile not found');

  // Safe select — never includes worker phone, CNIC, addresses, reference
  // contact, or storage paths. The only contact field (booking.workerPhone)
  // is server-controlled and set on invitation acceptance.
  const jobs = await prisma.jobRequest.findMany({
    where: { clientId: clientProfile.id },
    select: {
      id: true,
      status: true,
      type: true,
      description: true,
      urgency: true,
      budget: true,
      createdAt: true,
      updatedAt: true,
      category: { select: { id: true, name: true } },
      area: { select: { id: true, name: true } },
      targetWorker: { select: { id: true, name: true } },
      booking: {
        select: {
          id: true,
          status: true,
          confirmedAt: true,
          workerPhone: true, // Released contact — only exists after acceptance
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Map through the DTO to enforce the contact-release rule and
  // ensure no raw Prisma object with sensitive fields is returned.
  return jobs.map(toMyJobItem);
}
