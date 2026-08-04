/**
 * Invitation DTO — safe serialization for invitation API responses.
 *
 * Ensures that no sensitive worker fields (CNIC, addresses, storage paths,
 * reference-contact info, suspension reason, agentId, userId) are ever
 * returned from the invitations endpoints.
 *
 * Contact information (client/worker phone) is released ONLY through the
 * booking record created during invitation acceptance — never through
 * the invitation response itself.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface InvitationCategorySummary {
  id: string;
  name: string;
}

export interface InvitationAreaSummary {
  id: string;
  name: string;
}

export interface InvitationClientSummary {
  id: string;
  name: string | null;
}

export interface InvitationJobSummary {
  id: string;
  status: string;
  type: string;
  description: string;
  urgency: string;
  budget: number | null;
  category: InvitationCategorySummary;
  area: InvitationAreaSummary;
  client: InvitationClientSummary;
}

export interface InvitationBookingSummary {
  id: string;
  status: string;
  confirmedAt: string;
}

/** Shape returned by GET /pending */
export interface PendingInvitationDto {
  id: string;
  status: string;
  createdAt: string;
  jobRequest: InvitationJobSummary;
}

/** Shape returned by POST /:id/respond on acceptance */
export interface AcceptedInvitationDto {
  status: 'ACCEPTED';
  booking: InvitationBookingSummary;
}

/** Shape returned by POST /:id/respond on rejection */
export interface RejectedInvitationDto {
  status: 'REJECTED';
}

export type RespondInvitationDto = AcceptedInvitationDto | RejectedInvitationDto;

// ─── Input shapes (what the service layer returns from Prisma) ────────────

interface PrismaInvitationForPending {
  id: string;
  status: string;
  createdAt: Date;
  jobRequest: {
    id: string;
    status: string;
    type: string;
    description: string;
    urgency: string;
    budget: { toString(): string } | number | null;
    category: { id: string; name: string };
    area: { id: string; name: string };
    client: { id: string; name: string | null };
  };
}

interface PrismaBookingForAccept {
  id: string;
  status: string;
  confirmedAt: Date;
}

// ─── Serializers ───────────────────────────────────────────────────────────

/**
 * Convert a Prisma JobInvitation (with safe relations) to a PendingInvitationDto.
 *
 * Only allowlisted fields are included. No phone, CNIC, paths, or
 * reference-contact info ever appears.
 */
export function toPendingInvitationDto(inv: PrismaInvitationForPending): PendingInvitationDto {
  return {
    id: inv.id,
    status: inv.status,
    createdAt: inv.createdAt.toISOString(),
    jobRequest: {
      id: inv.jobRequest.id,
      status: inv.jobRequest.status,
      type: inv.jobRequest.type,
      description: inv.jobRequest.description,
      urgency: inv.jobRequest.urgency,
      budget: inv.jobRequest.budget === null ? null : Number(inv.jobRequest.budget),
      category: {
        id: inv.jobRequest.category.id,
        name: inv.jobRequest.category.name,
      },
      area: {
        id: inv.jobRequest.area.id,
        name: inv.jobRequest.area.name,
      },
      client: {
        id: inv.jobRequest.client.id,
        name: inv.jobRequest.client.name,
      },
    },
  };
}

/**
 * Convert a Prisma Booking to a safe AcceptedInvitationDto.
 *
 * The booking ID and status are safe to share. Contact phones are
 * intentionally excluded — they are available through GET /job-requests/mine
 * for the client side and are not needed in the acceptance response.
 */
export function toAcceptedInvitationDto(booking: PrismaBookingForAccept): AcceptedInvitationDto {
  return {
    status: 'ACCEPTED',
    booking: {
      id: booking.id,
      status: booking.status,
      confirmedAt: booking.confirmedAt.toISOString(),
    },
  };
}
