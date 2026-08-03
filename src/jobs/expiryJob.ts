/**
 * Background job to expire job requests and invitations that have not been responded to.
 *
 * The core expiry logic lives in src/services/expiryService.ts so it can be
 * tested independently without starting the cron scheduler.  This module
 * only wires up the cron schedule and delegates to that function.
 */

import cron from 'node-cron';
import { expireStaleInvitations } from '../services/expiryService';

export function startExpiryJob() {
  // Run every hour
  cron.schedule('0 * * * *', async () => {
    console.log('[Job] Running expiry check...');
    try {
      const result = await expireStaleInvitations();
      if (result.expiredRequests > 0) {
        console.log(
          `[Job] Expired ${result.expiredRequests} job requests and ${result.expiredInvitations} invitations.`
        );
      }
    } catch (err) {
      console.error('[Job] Error running expiry check:', err);
    }
  });
}
