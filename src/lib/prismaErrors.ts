/**
 * Prisma error translation utilities.
 *
 * Converts Prisma's internal error types into application-level
 * `AppError` instances with stable, machine-readable codes.
 *
 * Only known error patterns are mapped — unknown errors are left
 * untouched so the centralized error middleware can handle them.
 */

import { errors, ErrorCode, AppError } from './errors';

/**
 * A Prisma P2002 (unique constraint violation) error.
 *
 * Prisma sets `code` to `'P2002'` and `meta.target` to the list of
 * field names that violated the constraint.  We inspect `meta.target`
 * to determine which unique constraint was hit and map accordingly.
 */
interface PrismaUniqueConstraintError {
  code: 'P2002';
  meta?: {
    target?: string[];
  };
  message?: string;
}

/** Type guard for Prisma P2002 errors. */
function isPrismaUniqueConstraintError(err: unknown): err is PrismaUniqueConstraintError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}

/**
 * Translate a Prisma unique-constraint violation on `WorkerProfile.phone`
 * into an application-level conflict error.
 *
 * Returns `null` if the error is not a P2002 targeting the phone field,
 * so the caller can let the original error propagate to the generic
 * error middleware.
 *
 * @param err The caught error to inspect.
 * @returns An `AppError` (409 WORKER_PHONE_ALREADY_EXISTS) or `null`.
 */
export function translateWorkerPhoneConflict(err: unknown): AppError | null {
  if (!isPrismaUniqueConstraintError(err)) {
    return null;
  }

  const target = err.meta?.target;

  // Only map to a worker-phone conflict when the phone field is
  // explicitly identified as the violated constraint target.
  // A P2002 on a different field (e.g. userId, email) must not be
  // treated as a phone conflict.
  if (!target || !target.includes('phone')) {
    return null;
  }

  return errors.conflict(
    ErrorCode.WORKER_PHONE_ALREADY_EXISTS,
    'A worker with this phone number already exists',
  );
}
