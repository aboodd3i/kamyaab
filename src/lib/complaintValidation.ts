/**
 * Complaint validation utilities (Week 6).
 *
 * Provides Zod schemas for validating complaint input:
 *   - reason: required, trimmed, 1–2000 chars
 *   - resolution: optional, trimmed, max 2000 chars
 *   - status: optional, must be 'RESOLVED' or 'DISMISSED'
 */

import { z } from 'zod';

// ─── Constants ─────────────────────────────────────────────────────────────

export const MAX_REASON_LENGTH = 2000;
export const MAX_RESOLUTION_LENGTH = 2000;

// ─── Zod Schemas ───────────────────────────────────────────────────────────

/**
 * Reason schema — required, non-empty, trimmed string with a maximum length.
 */
export const complaintReasonSchema = z
  .string()
  .trim()
  .min(1, 'Reason is required')
  .max(MAX_REASON_LENGTH, `Reason must be at most ${MAX_REASON_LENGTH} characters`);

/**
 * Resolution schema — optional, trimmed string with a maximum length.
 */
export const complaintResolutionSchema = z
  .string()
  .trim()
  .max(MAX_RESOLUTION_LENGTH, `Resolution must be at most ${MAX_RESOLUTION_LENGTH} characters`)
  .optional();

/**
 * Admin resolution status — only RESOLVED or DISMISSED are valid actions.
 */
export const complaintResolutionStatusSchema = z.enum(['RESOLVED', 'DISMISSED']);

/**
 * Create complaint input schema — reason only.
 */
export const createComplaintSchema = z.object({
  reason: complaintReasonSchema,
});

/**
 * Resolve complaint input schema — status + optional resolution note.
 */
export const resolveComplaintSchema = z.object({
  status: complaintResolutionStatusSchema,
  resolution: complaintResolutionSchema,
});

// ─── Types ─────────────────────────────────────────────────────────────────

export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;
export type ResolveComplaintInput = z.infer<typeof resolveComplaintSchema>;
