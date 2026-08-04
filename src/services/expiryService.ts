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
 * Expire all SPECIFIC_WORKER job requests that are still WORKER_CONTACTED
 * past their expiresAt deadline, and mark their PENDING invitations as
 * EXPIRED.
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
  // Find all job requests that are WORKER_CONTACTED and expired
  const expiredRequests = await prisma.jobRequest.findMany({
    where: {
      status: 'WORKER_CONTACTED',
      expiresAt: { lt: now },
    },
    include: {
      client: { include: { user: true } },
      targetWorker: true,
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
      await sendMockSms(
        req.client.user.phone,
        `Kamyaab: Your job request for ${req.targetWorker?.name || 'the worker'} has expired without a response. You can create a new request and invite someone else.`
      );
    }
  }

  return {
    expiredRequests: expiredRequests.length,
    expiredInvitations: expiredInvitationCount,
  };
}
