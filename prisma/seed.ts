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
