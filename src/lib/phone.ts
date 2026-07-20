/**
 * Pakistani phone number validation and normalization.
 *
 * Accepts common formats:
 *   +92 3XX XXXXXXX
 *   03XX XXXXXXX
 *   3XX XXXXXXX  (without leading 0 or +92)
 *
 * Normalizes everything to E.164-ish: +923XXXXXXXXX
 *
 * Pakistani mobile numbers:
 *   Country code: 92
 *   Mobile prefixes: 3 (after trunk 0)
 *   Total national significant digits: 10 (0 + 9 digits)
 *   Mobile network: 30–39 range
 */

/** Matches Pakistani mobile numbers in various input formats. */
const PK_PHONE_REGEX = /^(?:\+92|0)?(3\d{9})$/;

/**
 * Validate and normalize a Pakistani mobile phone number.
 *
 * @returns The normalized form `+923XXXXXXXXX` if valid.
 * @throws {AppError} with `INVALID_PHONE` if the format is invalid.
 */
export function normalizePakistaniPhone(raw: string): string {
  const cleaned = raw.replace(/[\s\-()]/g, '');

  const match = cleaned.match(PK_PHONE_REGEX);
  if (!match) {
    throw new AppError(400, ErrorCode.INVALID_PHONE, 'Invalid Pakistani phone number format');
  }

  return `+92${match[1]}`;
}

/** Check whether a string is a valid Pakistani mobile number (no throw). */
export function isValidPakistaniPhone(raw: string): boolean {
  try {
    normalizePakistaniPhone(raw);
    return true;
  } catch {
    return false;
  }
}

// Import at bottom to avoid circular dependency (errors.ts has no deps on this file)
import { AppError, ErrorCode } from '../lib/errors';
