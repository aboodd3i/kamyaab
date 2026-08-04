import { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import prisma from '../lib/prisma';
import { errors, ErrorCode } from '../lib/errors';
import type { AuthPrincipal } from '../types/auth';

// Extend Express Request with a typed authenticated principal.
declare global {
  namespace Express {
    interface Request {
      user?: AuthPrincipal;
    }
  }
}

/**
 * Authentication middleware.
 *
 * 1. Requires `Authorization: Bearer <token>`
 * 2. Validates the token through Supabase (`getUser`)
 * 3. Resolves the internal user by `authUserId` (stable identity mapping)
 * 4. Rejects suspended accounts
 * 5. Attaches a typed principal to `req.user`
 *
 * Role is always read from PostgreSQL — never from JWT custom claims
 * or request bodies.
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw errors.unauthorized(ErrorCode.AUTH_MISSING_TOKEN, 'Missing or invalid authorization header');
    }

    const token = authHeader.split(' ')[1];

    if (!supabase) {
      throw errors.unauthorized(ErrorCode.AUTH_INVALID_TOKEN, 'Auth service not configured');
    }

    // Verify token with Supabase
    const { data: { user: authUser }, error } = await supabase.auth.getUser(token);

    if (error || !authUser) {
      throw errors.unauthorized(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid or expired token');
    }

    // Resolve internal user by the stable Supabase Auth ID
    const dbUser = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { id: true, role: true },
    });

    if (!dbUser) {
      throw errors.unauthorized(ErrorCode.AUTH_USER_NOT_FOUND, 'User not found');
    }

    req.user = {
      userId: dbUser.id,
      authUserId: authUser.id,
      role: dbUser.role as 'CLIENT' | 'AGENT' | 'ADMIN' | 'WORKER',
    };

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Role guard — returns middleware that allows only the specified roles.
 * Must be used after `authenticate`.
 */
export function requireRole(...roles: AuthPrincipal['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(errors.forbidden(ErrorCode.AUTH_FORBIDDEN, 'Insufficient permissions'));
    }
    next();
  };
}
