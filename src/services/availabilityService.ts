/**
 * Worker availability service.
 *
 * Workers can self-report their availability status (AVAILABLE / BUSY /
 * UNAVAILABLE) through the portal. The system also updates availability
 * automatically (e.g. on booking completion or expiry) via AUTO_EXPIRY.
 *
 * Only APPROVED workers can set their availability.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';

// ─── Types ─────────────────────────────────────────────────────────────────

export type AvailabilityStatus = 'AVAILABLE' | 'BUSY' | 'UNAVAILABLE' | 'UNKNOWN';
export type AvailabilityUpdateSource = 'WORKER_PORTAL' | 'SMS' | 'AGENT' | 'ADMIN' | 'AUTO_EXPIRY';

export interface SetAvailabilityInput {
  workerId: string;
  status: AvailabilityStatus;
  updateSource: AvailabilityUpdateSource;
  busyUntil?: Date | null;
}

export interface AvailabilityResult {
  workerId: string;
  status: AvailabilityStatus;
  updateSource: AvailabilityUpdateSource;
  busyUntil: string | null;
  updatedAt: string;
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * Set or update a worker's availability status.
 *
 * Uses upsert because the WorkerAvailability row may not exist yet
 * (it defaults to UNKNOWN when first created).
 *
 * @throws 404 if worker profile not found
 * @throws 403 if worker is not APPROVED
 */
export async function setAvailability(input: SetAvailabilityInput): Promise<AvailabilityResult> {
  const { workerId, status, updateSource, busyUntil } = input;

  // Verify worker exists and is APPROVED
  const worker = await prisma.workerProfile.findUnique({
    where: { id: workerId },
    select: { id: true, status: true },
  });

  if (!worker) {
    throw errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker profile not found');
  }

  if (worker.status !== 'APPROVED') {
    throw errors.forbidden(ErrorCode.AUTH_FORBIDDEN, 'Only approved workers can set availability');
  }

  // Upsert availability row
  const availability = await prisma.workerAvailability.upsert({
    where: { workerId },
    create: {
      workerId,
      status,
      updateSource,
      busyUntil: busyUntil ?? null,
    },
    update: {
      status,
      updateSource,
      busyUntil: busyUntil ?? null,
    },
    select: {
      workerId: true,
      status: true,
      updateSource: true,
      busyUntil: true,
      updatedAt: true,
    },
  });

  return {
    workerId: availability.workerId,
    status: availability.status as AvailabilityStatus,
    updateSource: availability.updateSource as AvailabilityUpdateSource,
    busyUntil: availability.busyUntil?.toISOString() ?? null,
    updatedAt: availability.updatedAt.toISOString(),
  };
}

/**
 * Get a worker's current availability status.
 *
 * Returns UNKNOWN if no availability record exists.
 */
export async function getAvailability(workerId: string): Promise<AvailabilityResult> {
  const availability = await prisma.workerAvailability.findUnique({
    where: { workerId },
    select: {
      workerId: true,
      status: true,
      updateSource: true,
      busyUntil: true,
      updatedAt: true,
    },
  });

  if (!availability) {
    return {
      workerId,
      status: 'UNKNOWN',
      updateSource: 'AUTO_EXPIRY',
      busyUntil: null,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    workerId: availability.workerId,
    status: availability.status as AvailabilityStatus,
    updateSource: availability.updateSource as AvailabilityUpdateSource,
    busyUntil: availability.busyUntil?.toISOString() ?? null,
    updatedAt: availability.updatedAt.toISOString(),
  };
}
