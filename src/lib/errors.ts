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

  // Internal
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  
  // Job / Generic State
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
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

  // Log full error server-side, never send to client
  console.error('Unhandled error:', err);

  const message = env.isProduction
    ? 'Internal server error'
    : err.message || 'Internal server error';

  sendError(res, 500, ErrorCode.INTERNAL_ERROR, message);
}
