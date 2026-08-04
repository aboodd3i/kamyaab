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
  role: 'CLIENT' | 'AGENT' | 'ADMIN' | 'WORKER';
  phone?: string | null;
  email?: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

/** POST /api/v1/workers — create a worker profile (AGENT only). */
export const CreateWorkerSchema = z
  .object({
    name: z.string().min(1).max(100),
    phone: z.string().min(1),
    // Week 3 optional fields — all caller-settable, none server-owned
    cnicNumber: z.string().nullable().optional(),
    referenceName: z.string().nullable().optional(),
    referencePhone: z.string().nullable().optional(),
    identityChecked: z.boolean().optional(),
    phoneConfirmed: z.boolean().optional(),
    backgroundChecked: z.boolean().optional(),
    skillAssessed: z.boolean().optional(),
    categoryIds: z.array(z.string().min(1)).optional(),
    serviceAreaIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (data) => {
      // Reject server-owned fields that callers must never supply
      const forbidden = [
        'rating',
        'ratingCount',
        'completedJobsCount',
        'status',
        'agentId',
        'userId',
        'referenceStatus',
        'referenceVerifiedById',
        'referenceVerifiedAt',
        'cnicFrontPath',
        'cnicBackPath',
        'suspensionReason',
      ];
      return !forbidden.some((key) => key in data);
    },
    { message: 'Server-owned fields cannot be set during creation' },
  );

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

// ---------------------------------------------------------------------------
// Job Requests & Bookings (Week 4)
// ---------------------------------------------------------------------------

export const CreateJobRequestSchema = z.object({
  categoryId: z.string().uuid(),
  areaId: z.string().uuid(),
  description: z.string().min(10, 'Description must be at least 10 characters').max(2000),
  urgency: z.enum(['FLEXIBLE', 'THIS_WEEK', 'URGENT']).optional().default('FLEXIBLE'),
  budget: z.coerce.number().positive('Budget must be positive').optional(),
  type: z.enum(['SPECIFIC_WORKER', 'OPEN']).optional().default('SPECIFIC_WORKER'),
});
export type CreateJobRequestInput = z.infer<typeof CreateJobRequestSchema>;

export const UpdateJobRequestSchema = z.object({
  categoryId: z.string().uuid().optional(),
  areaId: z.string().uuid().optional(),
  description: z.string().min(10).max(2000).optional(),
  urgency: z.enum(['FLEXIBLE', 'THIS_WEEK', 'URGENT']).optional(),
  budget: z.coerce.number().positive().optional().nullable(),
});
export type UpdateJobRequestInput = z.infer<typeof UpdateJobRequestSchema>;

export const SubmitJobRequestSchema = z.object({
  targetWorkerId: z.string().uuid('Target worker is required for specific worker job requests'),
});
export type SubmitJobRequestInput = z.infer<typeof SubmitJobRequestSchema>;

export const InvitationResponseSchema = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED']),
});
export type InvitationResponseInput = z.infer<typeof InvitationResponseSchema>;
