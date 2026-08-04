/**
 * Pakistani phone validation tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { normalizePakistaniPhone, isValidPakistaniPhone } from '../phone';

// Need to mock env for errors.ts which is imported by phone.ts
vi.mock('../../config/env', () => ({
  env: {
    databaseUrl: 'postgresql://dummy:dummy@localhost:5432/dummy',
    directUrl: 'postgresql://dummy:dummy@localhost:5432/dummy',
    supabaseUrl: 'https://dummy.supabase.co',
    supabaseAnonKey: 'dummy-anon-key',
    supabaseServiceRoleKey: undefined,
    port: 3000,
    nodeEnv: 'test',
    isProduction: false,
  },
}));

describe('normalizePakistaniPhone', () => {
  it('normalizes +92 format', () => {
    expect(normalizePakistaniPhone('+923001234567')).toBe('+923001234567');
  });

  it('normalizes 03XX format', () => {
    expect(normalizePakistaniPhone('03001234567')).toBe('+923001234567');
  });

  it('normalizes bare 3XX format', () => {
    expect(normalizePakistaniPhone('3001234567')).toBe('+923001234567');
  });

  it('strips whitespace, dashes, and parentheses', () => {
    expect(normalizePakistaniPhone('+92 300-123-4567')).toBe('+923001234567');
    expect(normalizePakistaniPhone('(0300) 123 4567')).toBe('+923001234567');
  });

  it('throws on invalid format (too short)', () => {
    expect(() => normalizePakistaniPhone('12345')).toThrow();
  });

  it('throws on invalid format (landline)', () => {
    expect(() => normalizePakistaniPhone('0211234567')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => normalizePakistaniPhone('')).toThrow();
  });

  it('throws on non-Pakistani country code', () => {
    expect(() => normalizePakistaniPhone('+919876543210')).toThrow();
  });
});

describe('isValidPakistaniPhone', () => {
  it('returns true for valid numbers', () => {
    expect(isValidPakistaniPhone('+923001234567')).toBe(true);
    expect(isValidPakistaniPhone('03001234567')).toBe(true);
    expect(isValidPakistaniPhone('3001234567')).toBe(true);
  });

  it('returns false for invalid numbers', () => {
    expect(isValidPakistaniPhone('12345')).toBe(false);
    expect(isValidPakistaniPhone('')).toBe(false);
    expect(isValidPakistaniPhone('+919876543210')).toBe(false);
    expect(isValidPakistaniPhone('0211234567')).toBe(false);
  });
});
