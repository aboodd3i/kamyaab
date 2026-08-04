// Optional local test data script (not part of official seed.ts) — 
// creates sample worker/client records for testing search/booking flows.
// Run manually if useful: npx tsx prisma/testdata.ts
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const electrician = await prisma.category.findUniqueOrThrow({ where: { name: 'Electrician' } });
  const plumber = await prisma.category.findUniqueOrThrow({ where: { name: 'Plumber' } });
  const gulshan = await prisma.area.findUniqueOrThrow({ where: { slug: 'gulshan-e-iqbal' } });
  const clifton = await prisma.area.findUniqueOrThrow({ where: { slug: 'clifton' } });
  const agent = await prisma.user.findUniqueOrThrow({ where: { email: 'agent1@kamyaab.pk' } });

  const clientUser = await prisma.user.upsert({
    where: { phone: '03001112222' },
    update: {},
    create: { phone: '03001112222', role: 'CLIENT' },
  });
  await prisma.clientProfile.upsert({
    where: { userId: clientUser.id },
    update: {},
    create: { userId: clientUser.id, name: 'Test Client One' },
  });

  const worker1 = await prisma.workerProfile.upsert({
    where: { phone: '03005551111' },
    update: {},
    create: {
      name: 'Test Electrician Approved',
      phone: '03005551111',
      status: 'APPROVED',
      agentId: agent.id,
      identityChecked: true,
      phoneConfirmed: true,
      rating: 4.5,
      ratingCount: 10,
      completedJobsCount: 8,
      categories: { create: [{ categoryId: electrician.id }] },
      serviceAreas: { create: [{ areaId: gulshan.id }] },
    },
  });

  const worker2 = await prisma.workerProfile.upsert({
    where: { phone: '03005552222' },
    update: {},
    create: {
      name: 'Test Plumber Pending',
      phone: '03005552222',
      status: 'PENDING_APPROVAL',
      agentId: agent.id,
      categories: { create: [{ categoryId: plumber.id }] },
      serviceAreas: { create: [{ areaId: clifton.id }] },
    },
  });

  console.log('Test data created:', { worker1: worker1.id, worker2: worker2.id });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });