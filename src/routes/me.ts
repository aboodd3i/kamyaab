import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import prisma from '../lib/prisma';
import { errors, ErrorCode, sendSuccess } from '../lib/errors';
import type { MeResponseData } from '../types';

const router = Router();

/**
 * GET /api/v1/me
 *
 * Returns the authenticated user's identity and role.
 *
 * For clients (phone-OTP users), if this is their first call after
 * Supabase Auth enrollment, we idempotently create the internal User
 * row and an empty ClientProfile inside a transaction.
 *
 * For staff (AGENT / ADMIN), the row must already exist — it is
 * provisioned by `scripts/seed-auth.ts`.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw errors.unauthorized(ErrorCode.AUTH_MISSING_TOKEN, 'Missing or invalid authorization header');
    }

    const token = authHeader.split(' ')[1];

    // Verify the JWT with Supabase
    const { data: { user: authUser }, error } = await supabase.auth.getUser(token);

    if (error || !authUser) {
      throw errors.unauthorized(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid or expired token');
    }

    // Try to find the internal user by the stable Supabase Auth ID
    let dbUser = await prisma.user.findUnique({
      where: { authUserId: authUser.id },
      select: { id: true, authUserId: true, role: true, phone: true, email: true },
    });

    // If not found, this may be a first-time client — bootstrap idempotently
    if (!dbUser) {
      const phone = authUser.phone ?? null;
      const email = authUser.email ?? null;

      // Only auto-create users with no staff-like metadata.
      // Staff must be pre-provisioned via scripts/seed-auth.ts.
      dbUser = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            authUserId: authUser.id,
            phone,
            email,
            role: 'CLIENT',
          },
          select: { id: true, authUserId: true, role: true, phone: true, email: true },
        });

        await tx.clientProfile.create({
          data: { userId: newUser.id },
        });

        return newUser;
      });
    }

    // Reject suspended worker accounts
    if (dbUser.role === 'AGENT') {
      const workerProfile = await prisma.workerProfile.findUnique({
        where: { userId: dbUser.id },
        select: { status: true },
      });
      if (workerProfile?.status === 'SUSPENDED') {
        throw errors.forbidden(ErrorCode.AUTH_ACCOUNT_SUSPENDED, 'Account suspended');
      }
    }

    const response: MeResponseData = {
      userId: dbUser.id,
      authUserId: dbUser.authUserId!,
      role: dbUser.role,
      phone: dbUser.phone,
      email: dbUser.email,
    };

    return sendSuccess(res, response);
  } catch (err) {
    next(err);
  }
});

export default router;
