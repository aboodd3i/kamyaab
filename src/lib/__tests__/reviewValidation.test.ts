/**
 * Unit tests for review validation utilities (Week 6).
 */

import { describe, it, expect } from 'vitest';
import {
  ratingSchema,
  commentSchema,
  reviewInputSchema,
  validateRating,
  validateComment,
  validateReviewInput,
  MIN_RATING,
  MAX_RATING,
  MAX_COMMENT_LENGTH,
} from '../reviewValidation';

describe('Review Validation — ratingSchema', () => {
  it('accepts integers 1 through 5', () => {
    for (let i = MIN_RATING; i <= MAX_RATING; i++) {
      expect(ratingSchema.parse(i)).toBe(i);
    }
  });

  it('rejects 0', () => {
    expect(() => ratingSchema.parse(0)).toThrow();
  });

  it('rejects 6', () => {
    expect(() => ratingSchema.parse(6)).toThrow();
  });

  it('rejects non-integer floats', () => {
    expect(() => ratingSchema.parse(3.5)).toThrow();
  });

  it('rejects NaN', () => {
    expect(() => ratingSchema.parse(NaN)).toThrow();
  });

  it('rejects strings', () => {
    expect(() => ratingSchema.parse('3')).toThrow();
  });
});

describe('Review Validation — commentSchema', () => {
  it('accepts undefined (optional)', () => {
    expect(commentSchema.parse(undefined)).toBeUndefined();
  });

  it('accepts a normal string', () => {
    expect(commentSchema.parse('Great service!')).toBe('Great service!');
  });

  it('trims whitespace', () => {
    expect(commentSchema.parse('  hello  ')).toBe('hello');
  });

  it('accepts a string at max length', () => {
    const s = 'a'.repeat(MAX_COMMENT_LENGTH);
    expect(commentSchema.parse(s)).toBe(s);
  });

  it('rejects a string exceeding max length', () => {
    const s = 'a'.repeat(MAX_COMMENT_LENGTH + 1);
    expect(() => commentSchema.parse(s)).toThrow();
  });

  it('accepts an empty trimmed string (becomes empty)', () => {
    expect(commentSchema.parse('   ')).toBe('');
  });
});

describe('Review Validation — reviewInputSchema', () => {
  it('accepts a valid input with rating and comment', () => {
    const result = reviewInputSchema.parse({ rating: 4, comment: 'Good work' });
    expect(result.rating).toBe(4);
    expect(result.comment).toBe('Good work');
  });

  it('accepts a valid input with rating only', () => {
    const result = reviewInputSchema.parse({ rating: 5 });
    expect(result.rating).toBe(5);
    expect(result.comment).toBeUndefined();
  });

  it('rejects missing rating', () => {
    expect(() => reviewInputSchema.parse({ comment: 'No rating' })).toThrow();
  });

  it('rejects invalid rating', () => {
    expect(() => reviewInputSchema.parse({ rating: 0 })).toThrow();
  });

  it('trims the comment', () => {
    const result = reviewInputSchema.parse({ rating: 3, comment: '  spaced  ' });
    expect(result.comment).toBe('spaced');
  });
});

describe('Review Validation — helper functions', () => {
  it('validateRating returns the integer for valid input', () => {
    expect(validateRating(3)).toBe(3);
  });

  it('validateRating throws for invalid input', () => {
    expect(() => validateRating(10)).toThrow();
  });

  it('validateComment returns trimmed string for valid input', () => {
    expect(validateComment('  hi  ')).toBe('hi');
  });

  it('validateComment returns undefined for undefined', () => {
    expect(validateComment(undefined)).toBeUndefined();
  });

  it('validateReviewInput returns validated object', () => {
    const result = validateReviewInput({ rating: 2, comment: '  ok  ' });
    expect(result).toEqual({ rating: 2, comment: 'ok' });
  });

  it('validateReviewInput throws for invalid input', () => {
    expect(() => validateReviewInput({ rating: -1 })).toThrow();
  });
});
