/**
 * Centralized error handling for the Kamyaab backend.
 *
 * Provides a stable, machine-readable error response format and an
 * Express error middleware that never leaks stack traces in production.
 */

import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/** Stable machine-readable error codes. */
export const ErrorCode = {
  // Auth
  AUTH_MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_USER_NOT_FOUND: 'AUTH_USER_NOT_FOUND',
  AUTH_ACCOUNT_SUSPENDED: 'AUTH_ACCOUNT_SUSPENDED',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_PHONE: 'INVALID_PHONE',

  // Resources
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  // Workers
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
  WORKER_DUPLICATE_PHONE: 'WORKER_DUPLICATE_PHONE',
  WORKER_PHONE_ALREADY_EXISTS: 'WORKER_PHONE_ALREADY_EXISTS',
  WORKER_INVALID_TRANSITION: 'WORKER_INVALID_TRANSITION',
  WORKER_CLAIM_FAILED: 'WORKER_CLAIM_FAILED',
  WORKER_ALREADY_CLAIMED: 'WORKER_ALREADY_CLAIMED',
  WORKER_PROFILE_SUSPENDED: 'WORKER_PROFILE_SUSPENDED',
  WORKER_ALREADY_LINKED: 'WORKER_ALREADY_LINKED',
  WORKER_CLAIM_RATE_LIMITED: 'WORKER_CLAIM_RATE_LIMITED',

  // Internal
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  
  // Job / Generic State
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // Bookings
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  BOOKING_INVALID_STATE: 'BOOKING_INVALID_STATE',

  // Reviews (Week 6)
  REVIEW_ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
  INVALID_REVIEW_RATING: 'INVALID_REVIEW_RATING',
  REVIEW_NOT_ALLOWED: 'REVIEW_NOT_ALLOWED',
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',

  // Complaints (Week 6)
  COMPLAINT_NOT_FOUND: 'COMPLAINT_NOT_FOUND',
  COMPLAINT_ALREADY_RESOLVED: 'COMPLAINT_ALREADY_RESOLVED',
  COMPLAINT_INVALID_TRANSITION: 'COMPLAINT_INVALID_TRANSITION',

  // Rate limiting (Week 7)
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Standard API error response shape. */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** Standard API success response shape. */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

/**
 * Application error that carries a stable code and HTTP status.
 * Use this to throw from route handlers — the error middleware
 * will format the response consistently.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Convenience factory functions for common errors. */
export const errors = {
  badRequest: (code: ErrorCode, message: string) =>
    new AppError(400, code, message),
  unauthorized: (code: ErrorCode, message: string) =>
    new AppError(401, code, message),
  forbidden: (code: ErrorCode, message: string) =>
    new AppError(403, code, message),
  notFound: (code: ErrorCode, message: string) =>
    new AppError(404, code, message),
  conflict: (code: ErrorCode, message: string) =>
    new AppError(409, code, message),
  unprocessable: (code: ErrorCode, message: string) =>
    new AppError(422, code, message),
  internal: (message = 'Internal server error') =>
    new AppError(500, ErrorCode.INTERNAL_ERROR, message),
};

/** Send a success response with the standard shape. */
export function sendSuccess<T>(res: Response, data: T, message?: string, status = 200) {
  const body: ApiSuccessResponse<T> = { success: true, data, message };
  return res.status(status).json(body);
}

/** Send an error response with the standard shape. */
export function sendError(res: Response, statusCode: number, code: ErrorCode, message: string) {
  const body: ApiErrorResponse = {
    success: false,
    error: { code, message },
  };
  return res.status(statusCode).json(body);
}

/**
 * Express error middleware — must be registered last (after all routes).
 * Converts AppError instances to the standard response shape.
 * Falls back to a generic 500 for unexpected errors.
 * Never includes stack traces in production.
 */
export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    sendError(res, err.statusCode, err.code, err.message);
    return;
  }

  // Zod validation errors
  if (err.name === 'ZodError') {
    sendError(res, 400, ErrorCode.VALIDATION_ERROR, 'Invalid request body');
    return;
  }

  // Multer file-upload errors (e.g. too many files, file too large)
  if (err.name === 'MulterError' || (typeof (err as unknown as { code?: string }).code === 'string' && (err as unknown as { code: string }).code.startsWith('LIMIT_'))) {
    const multerCode = (err as unknown as { code: string }).code;
    let message = 'File upload error';
    if (multerCode === 'LIMIT_FILE_SIZE') {
      message = 'File size exceeds the maximum allowed limit';
    } else if (multerCode === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Too many files uploaded';
    }
    sendError(res, 400, ErrorCode.VALIDATION_ERROR, message);
    return;
  }

  // Log full error server-side, never send to client
  console.error('Unhandled error:', err);

  const message = env.isProduction || env.isStaging
    ? 'Internal server error'
    : err.message || 'Internal server error';

  sendError(res, 500, ErrorCode.INTERNAL_ERROR, message);
}
