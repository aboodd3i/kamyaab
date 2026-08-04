/**
 * Review validation utilities (Week 6).
 *
 * Provides Zod schemas and helper functions for validating review
 * input (rating and comment) before it reaches the service layer.
 *
 * These utilities are intended for use by future review endpoints.
 * No routes are registered here.
 */

import { z } from 'zod';

// ─── Constants ─────────────────────────────────────────────────────────────

export const MIN_RATING = 1;
export const MAX_RATING = 5;
export const MAX_COMMENT_LENGTH = 1000;

// ─── Zod Schemas ───────────────────────────────────────────────────────────

/**
 * Rating schema — integer between 1 and 5 inclusive.
 */
export const ratingSchema = z
  .number()
  .int('Rating must be an integer')
  .min(MIN_RATING, `Rating must be at least ${MIN_RATING}`)
  .max(MAX_RATING, `Rating must be at most ${MAX_RATING}`);

/**
 * Comment schema — optional, trimmed string with a maximum length.
 */
export const commentSchema = z
  .string()
  .trim()
  .max(MAX_COMMENT_LENGTH, `Comment must be at most ${MAX_COMMENT_LENGTH} characters`)
  .optional();

/**
 * Full review input schema — rating + optional comment.
 * Used by future POST endpoints.
 */
export const reviewInputSchema = z.object({
  rating: ratingSchema,
  comment: commentSchema,
});

// ─── Types ─────────────────────────────────────────────────────────────────

export type ReviewInput = z.infer<typeof reviewInputSchema>;

// ─── Validation Helpers ────────────────────────────────────────────────────

/**
 * Validate a rating value.
 * Returns the validated integer or throws a ZodError.
 */
export function validateRating(rating: unknown): number {
  return ratingSchema.parse(rating);
}

/**
 * Validate a comment value.
 * Returns the validated (trimmed) string or undefined, or throws a ZodError.
 */
export function validateComment(comment: unknown): string | undefined {
  return commentSchema.parse(comment);
}

/**
 * Validate a full review input object.
 * Returns the validated and normalized input, or throws a ZodError.
 */
export function validateReviewInput(input: unknown): ReviewInput {
  return reviewInputSchema.parse(input);
}
