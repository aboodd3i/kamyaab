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
// Workers
// ---------------------------------------------------------------------------

/** POST /api/v1/workers — create a worker profile (AGENT only). */
export const CreateWorkerSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().min(1),
});

export type CreateWorkerBody = z.infer<typeof CreateWorkerSchema>;

/** Safe worker DTO — no internal relation details leaked to clients. */
export interface WorkerDTO {
  id: string;
  name: string;
  phone: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'SUSPENDED';
  suspensionReason?: string | null;
  agentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** PATCH /api/v1/workers/:id/verify — approve or suspend (ADMIN only). */
export const VerifyWorkerSchema = z
  .object({
    status: z.enum(['APPROVED', 'SUSPENDED']),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (data) => {
      // reason is only allowed (and required) when suspending
      if (data.status === 'SUSPENDED') return true;
      return data.reason === undefined;
    },
    { message: 'Reason is only allowed when status is SUSPENDED' },
  );

export type VerifyWorkerBody = z.infer<typeof VerifyWorkerSchema>;

