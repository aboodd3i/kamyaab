/**
 * Expiry service — core business logic for expiring stale job requests
 * and their pending invitations.
 *
 * Extracted from expiryJob.ts so that:
 *   - tests can import and invoke the expiry operation directly without
 *     starting the cron scheduler or leaving open handles;
 *   - the cron callback in expiryJob.ts stays thin and delegates here.
 */

import prisma from '../lib/prisma';
import { sendMockSms } from './mockSmsService';

/** Result summary returned by expireStaleInvitations. */
export interface ExpiryResult {
  /** Number of job requests transitioned from WORKER_CONTACTED → EXPIRED. */
  expiredRequests: number;
  /** Number of PENDING invitations transitioned → EXPIRED. */
  expiredInvitations: number;
}

/**
 * Expire all job requests that are still WORKER_CONTACTED or MATCHING
 * past their expiresAt deadline, and mark their PENDING invitations as
 * EXPIRED.
 *
 * For SPECIFIC_WORKER (WORKER_CONTACTED) jobs: the client is told they
 * can invite someone else.
 * For OPEN (MATCHING) jobs: the client is told no workers accepted.
 *
 * Safe to run repeatedly — on a second invocation with no new stale
 * records, it returns { 0, 0 } and performs no writes.
 *
 * Accepted and rejected invitations are never touched.
 * No Booking is ever created by this function.
 *
 * @param now Optional clock value (defaults to current time).  Allows
 *            tests to pass a fixed timestamp if needed.
 */
export async function expireStaleInvitations(now: Date = new Date()): Promise<ExpiryResult> {
  // Find all job requests that are WORKER_CONTACTED or MATCHING and expired
  const expiredRequests = await prisma.jobRequest.findMany({
    where: {
      status: { in: ['WORKER_CONTACTED', 'MATCHING'] },
      expiresAt: { lt: now },
    },
    include: {
      client: { include: { user: true } },
      targetWorker: true,
      category: { select: { name: true } },
      invitations: {
        where: { status: 'PENDING' },
      },
    },
  });

  if (expiredRequests.length === 0) {
    return { expiredRequests: 0, expiredInvitations: 0 };
  }

  let expiredInvitationCount = 0;

  for (const req of expiredRequests) {
    await prisma.$transaction(async (tx) => {
      // Mark job request as EXPIRED
      await tx.jobRequest.update({
        where: { id: req.id },
        data: { status: 'EXPIRED' },
      });

      // Mark pending invitations as EXPIRED
      for (const inv of req.invitations) {
        await tx.jobInvitation.update({
          where: { id: inv.id },
          data: { status: 'EXPIRED' },
        });
        expiredInvitationCount++;
      }
    });

    // Notify client via mock SMS (outside transaction)
    if (req.client.user.phone) {
      const message = req.status === 'MATCHING'
        ? `Kamyaab: Your open job request for ${req.category.name} has expired. No matched workers accepted in time. You can create a new request.`
        : `Kamyaab: Your job request for ${req.targetWorker?.name || 'the worker'} has expired without a response. You can create a new request and invite someone else.`;
      await sendMockSms(req.client.user.phone, message);
    }
  }

  return {
    expiredRequests: expiredRequests.length,
    expiredInvitations: expiredInvitationCount,
  };
}
