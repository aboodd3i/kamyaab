/**
 * Background job to expire job requests and invitations that have not been responded to.
 */

import cron from 'node-cron';
import prisma from '../lib/prisma';
import { sendMockSms } from '../services/mockSmsService';

export function startExpiryJob() {
  // Run every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[Job] Running expiry check...');
    try {
      const now = new Date();

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
        return;
      }

      console.log(`[Job] Found ${expiredRequests.length} expired job requests.`);

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
          }
        });

        // Notify client
        if (req.client.user.phone) {
          await sendMockSms(
            req.client.user.phone,
            `Kamyaab: Your job request for ${req.targetWorker?.name || 'the worker'} has expired without a response. You can create a new request and invite someone else.`
          );
        }
      }
    } catch (err) {
      console.error('[Job] Error running expiry check:', err);
    }
  });
}
