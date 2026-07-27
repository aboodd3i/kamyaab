import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { createDraft, updateDraft, submitJobRequest } from '../src/services/jobRequestService';
import { getPendingInvitations, respondToInvitation } from '../src/services/invitationService';

async function ensureWeek4TestData() {
  const categoryName = 'Plumber';
  const areaName = 'Clifton';
  const areaSlug = 'clifton-week4';

  const clientEmail = 'week4-client@example.com';
  const clientPhone = '+923330000001';
  const workerEmail = 'week4-worker@example.com';
  const workerPhone = '+923330000002';

  const category = await prisma.category.upsert({
    where: { name: categoryName },
    update: {},
    create: { name: categoryName },
  });

  const area = await prisma.area.upsert({
    where: { slug: areaSlug },
    update: { name: areaName },
    create: { name: areaName, slug: areaSlug },
  });

  const clientUser = await prisma.user.upsert({
    where: { email: clientEmail },
    update: { role: 'CLIENT', phone: clientPhone },
    create: {
      email: clientEmail,
      phone: clientPhone,
      role: 'CLIENT',
    },
  });

  await prisma.clientProfile.upsert({
    where: { userId: clientUser.id },
    update: { name: 'Week 4 Client' },
    create: {
      userId: clientUser.id,
      name: 'Week 4 Client',
    },
  });

  const workerUser = await prisma.user.upsert({
    where: { email: workerEmail },
    update: { role: 'AGENT', phone: workerPhone },
    create: {
      email: workerEmail,
      phone: workerPhone,
      role: 'AGENT',
    },
  });

  const workerProfile = await prisma.workerProfile.upsert({
    where: { phone: workerPhone },
    update: {
      userId: workerUser.id,
      name: 'Week 4 Worker',
      status: 'APPROVED',
    },
    create: {
      phone: workerPhone,
      userId: workerUser.id,
      name: 'Week 4 Worker',
      status: 'APPROVED',
    },
  });

  await prisma.workerCategory.upsert({
    where: {
      workerId_categoryId: {
        workerId: workerProfile.id,
        categoryId: category.id,
      },
    },
    update: {},
    create: {
      workerId: workerProfile.id,
      categoryId: category.id,
    },
  });

  await prisma.workerServiceArea.upsert({
    where: {
      workerId_areaId: {
        workerId: workerProfile.id,
        areaId: area.id,
      },
    },
    update: {},
    create: {
      workerId: workerProfile.id,
      areaId: area.id,
    },
  });

  return { category, area, clientUser, workerProfile };
}

async function main() {
  const { category, area, clientUser, workerProfile } = await ensureWeek4TestData();

  const draft = await createDraft(clientUser.id, {
    categoryId: category.id,
    areaId: area.id,
    description: 'Need a plumber for a kitchen sink repair',
    urgency: 'THIS_WEEK',
    budget: 5000,
    type: 'SPECIFIC_WORKER',
  });

  const updated = await updateDraft(draft.id, clientUser.id, {
    budget: 6000,
    description: 'Need a plumber for a kitchen sink repair urgently',
  });

  const submitted = await submitJobRequest(updated.id, clientUser.id, {
    targetWorkerId: workerProfile.id,
  });

  const pending = await getPendingInvitations(workerProfile.id);
  if (pending.length === 0) {
    throw new Error('No pending invitation was created for the test worker');
  }

  const accepted = await respondToInvitation(pending[0].id, workerProfile.id, {
    status: 'ACCEPTED',
  });

  console.log('Week 4 flow completed successfully');
  console.log(JSON.stringify(
    {
      clientUserId: clientUser.id,
      workerProfileId: workerProfile.id,
      jobRequestId: submitted.id,
      invitationId: pending[0].id,
      bookingId: accepted.booking.id,
      bookingStatus: accepted.booking.status,
    },
    null,
    2,
  ));
}

main()
  .catch((error) => {
    console.error('Week 4 test flow failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
