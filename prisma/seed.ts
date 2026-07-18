import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  await prisma.category.createMany({
    data: [
      { name: 'Electrician' },
      { name: 'Plumber' },
      { name: 'Carpenter' },
      { name: 'Painter' },
      { name: 'AC Technician' },
    ],
    skipDuplicates: true,
  });

  await prisma.area.createMany({
    data: [
      { name: 'East' },
      { name: 'Central' },
      { name: 'Gulshan' },
      { name: 'Clifton' },
    ],
    skipDuplicates: true,
  });

  // Seed Admin Account
  await prisma.user.upsert({
    where: { email: 'admin@kamyaab.pk' },
    update: {},
    create: {
      email: 'admin@kamyaab.pk',
      role: 'ADMIN',
    },
  });

  // Seed Agent Account
  await prisma.user.upsert({
    where: { email: 'agent1@kamyaab.pk' },
    update: {},
    create: {
      email: 'agent1@kamyaab.pk',
      role: 'AGENT',
    },
  });

  console.log('Seed data created successfully');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
