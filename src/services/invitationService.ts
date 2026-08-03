/**
 * Invitation service — handles accepting/rejecting invitations and creating bookings.
 */

import prisma from '../lib/prisma';
import { errors, ErrorCode, AppError } from '../lib/errors';
import { sendMockSms } from './mockSmsService';
import { toPendingInvitationDto, toAcceptedInvitationDto } from '../lib/invitationDto';
import type { InvitationResponseInput } from '../types';

/**
 * Worker responds to an invitation.
 * If ACCEPTED: Creates a Booking and releases contact info.
 * If REJECTED: Sends the JobRequest back to DRAFT state so client can invite someone else.
 *
 * Returns a safe DTO — never a raw Prisma object.
 */
export async function respondToInvitation(
  invitationId: string,
  workerId: string,
  input: InvitationResponseInput
) {
  const invitation = await prisma.jobInvitation.findUnique({
    where: { id: invitationId },
    include: {
      jobRequest: { include: { client: { include: { user: true } }, category: true } },
      worker: true,
    },
  });

  if (!invitation) {
    throw errors.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Invitation not found');
  }
  if (invitation.workerId !== workerId) {
    throw errors.forbidden(ErrorCode.AUTH_FORBIDDEN, 'You can only respond to your own invitations');
  }
  if (invitation.status !== 'PENDING') {
    throw errors.badRequest(
      ErrorCode.INVALID_STATE_TRANSITION,
      `Cannot respond to an invitation that is already ${invitation.status}`
    );
  }
  // Check if job request is still waiting for response
  if (invitation.jobRequest.status !== 'WORKER_CONTACTED') {
    throw errors.badRequest(
      ErrorCode.INVALID_STATE_TRANSITION,
      'The associated job request is no longer available'
    );
  }
  // Check expiration
  if (invitation.jobRequest.expiresAt && invitation.jobRequest.expiresAt < new Date()) {
    throw errors.badRequest(
      ErrorCode.INVALID_STATE_TRANSITION,
      'This invitation has expired'
    );
  }

  const { jobRequest, worker } = invitation;

  if (input.status === 'ACCEPTED') {
    // Transaction: Accept Invitation -> Update JobRequest -> Create Booking
    // If a concurrent accept already created a booking (P2002 on jobRequestId
    // or invitationId unique constraints), we treat it as idempotent and
    // return the existing booking.
    try {
      const booking = await prisma.$transaction(async (tx) => {
        await tx.jobInvitation.update({
          where: { id: invitationId },
          data: {
            status: 'ACCEPTED',
            respondedAt: new Date(),
          },
        });

        await tx.jobRequest.update({
          where: { id: jobRequest.id },
          data: {
            status: 'ACCEPTED',
          },
        });

        const newBooking = await tx.booking.create({
          data: {
            jobRequestId: jobRequest.id,
            invitationId: invitationId,
            workerId: worker.id,
            clientPhone: jobRequest.client.user.phone || '', // Release contact
            workerPhone: worker.phone,           // Release contact
            status: 'CONFIRMED',
          },
        });

        return newBooking;
      });

      // Notify client via Mock SMS
      if (jobRequest.client.user.phone) {
        await sendMockSms(
          jobRequest.client.user.phone,
          `Kamyaab: Great news! ${worker.name} has accepted your ${jobRequest.category.name} job request. You can now view their contact number in your bookings.`
        );
      }

      return toAcceptedInvitationDto(booking);
    } catch (err) {
      // P2002 — unique constraint violation on Booking.jobRequestId or Booking.invitationId.
      // A concurrent acceptance already created the booking. Treat as idempotent:
      // fetch the existing booking and return it as a successful acceptance.
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'P2002') {
        const existingBooking = await prisma.booking.findUnique({
          where: { invitationId },
          select: { id: true, status: true, confirmedAt: true },
        });

        if (existingBooking) {
          return toAcceptedInvitationDto(existingBooking);
        }
      }
      throw err;
    }
  } else {
    // REJECTED
    // Transaction: Reject Invitation -> Revert JobRequest to DRAFT
    await prisma.$transaction(async (tx) => {
      await tx.jobInvitation.update({
        where: { id: invitationId },
        data: {
          status: 'REJECTED',
          respondedAt: new Date(),
        },
      });

      await tx.jobRequest.update({
        where: { id: jobRequest.id },
        data: {
          status: 'DRAFT',
          targetWorkerId: null, // Clear target so they can pick someone else
          submittedAt: null,
          expiresAt: null,
        },
      });
    });

    // Notify client via Mock SMS
    if (jobRequest.client.user.phone) {
      await sendMockSms(
        jobRequest.client.user.phone,
        `Kamyaab: ${worker.name} is currently unavailable for your ${jobRequest.category.name} job. Your request has been moved back to drafts so you can invite another worker.`
      );
    }

    return { status: 'REJECTED' as const };
  }
}

/** Get pending invitations for a worker. Returns safe DTOs. */
export async function getPendingInvitations(workerId: string) {
  const invitations = await prisma.jobInvitation.findMany({
    where: {
      workerId,
      status: 'PENDING',
      jobRequest: { status: 'WORKER_CONTACTED' },
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      jobRequest: {
        select: {
          id: true,
          status: true,
          type: true,
          description: true,
          urgency: true,
          budget: true,
          category: { select: { id: true, name: true } },
          area: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } }, // Do NOT include phone here
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return invitations.map(toPendingInvitationDto);
}
