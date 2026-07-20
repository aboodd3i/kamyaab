/**
 * API contracts — Zod schemas and TypeScript types.
 *
 * Validation schemas live here and are imported by route handlers.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Auth: Staff Login (POST /api/v1/auth/login/staff)
// ---------------------------------------------------------------------------

export const StaffLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type StaffLoginBody = z.infer<typeof StaffLoginSchema>;

export interface StaffLoginResponse {
  success: true;
  data: {
    token: string;
    role: 'AGENT' | 'ADMIN';
  };
  message: string;
}

// ---------------------------------------------------------------------------
// Auth: Me (GET /api/v1/me)
// ---------------------------------------------------------------------------

export interface MeResponseData {
  userId: string;
  authUserId: string;
  role: 'CLIENT' | 'AGENT' | 'ADMIN';
  phone?: string | null;
  email?: string | null;
}

// ---------------------------------------------------------------------------
// Workers (unchanged — do not modify worker onboarding contracts)
// ---------------------------------------------------------------------------

export interface CreateWorkerBody {
  name: string;
  phone: string;
}

export interface VerifyWorkerBody {
  status: 'APPROVED' | 'SUSPENDED';
}

