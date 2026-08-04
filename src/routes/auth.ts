import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import prisma from '../lib/prisma';
import { StaffLoginSchema } from '../types';
import { errors, ErrorCode, sendSuccess, AppError } from '../lib/errors';

const router = Router();

/**
 * POST /login/staff
 *
 * Staff (AGENT / ADMIN) email-password login via Supabase Auth.
 * The frontend calls Supabase directly for OTP; this route is only for
 * staff who need a server-issued role confirmation.
 *
 * The user must already exist in PostgreSQL with the correct role and
 * an `authUserId` linking them to their Supabase Auth account (see
 * `scripts/seed-auth.ts`).
 */
router.post('/login/staff', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = StaffLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid email or password');
    }
    const { email, password } = parsed.data;

    if (!supabase) {
      throw errors.unauthorized(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Auth service not configured');
    }

    // Authenticate against Supabase
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      throw errors.unauthorized(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        error?.message || 'Invalid credentials',
      );
    }

    // Resolve internal user by the stable Supabase Auth ID
    const dbUser = await prisma.user.findUnique({
      where: { id: data.user.id },
      select: { id: true, role: true },
    });

    if (!dbUser) {
      throw errors.unauthorized(ErrorCode.AUTH_USER_NOT_FOUND, 'Staff account not linked');
    }

    if (dbUser.role !== 'AGENT' && dbUser.role !== 'ADMIN') {
      throw errors.forbidden(ErrorCode.AUTH_FORBIDDEN, 'Not a staff account');
    }

    return sendSuccess(
      res,
      { token: data.session!.access_token, role: dbUser.role },
      'Staff login successful',
    );
  } catch (err) {
    next(err);
  }
});

export default router;
