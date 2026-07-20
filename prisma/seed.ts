import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // --- Categories (12 confirmed MVP categories, per architecture doc) --------
  await prisma.category.createMany({
    data: [
      { name: 'Electrician' },
      { name: 'Plumber' },
      { name: 'Carpenter' },
      { name: 'Painter' },
      { name: 'Gardener' },
      { name: 'AC Technician' },
      { name: 'Appliance Repair Technician' },
      { name: 'Mason' },
      { name: 'Welder' },
      { name: 'Cleaner' },
      { name: 'Driver' },
      { name: 'General Handyman' },
    ],
    skipDuplicates: true,
  });
  // --- Karachi area hierarchy ------------------------------------------------
  // Structure: Karachi (root) → districts → areas
  // Using slugs as stable unique identifiers for parent-child linking.

  // Root
  const karachi = await prisma.area.upsert({
    where: { slug: 'karachi' },
    update: {},
    create: { name: 'Karachi', slug: 'karachi' },
  });

  // Districts (children of Karachi)
  const east = await prisma.area.upsert({
    where: { slug: 'east' },
    update: { parentId: karachi.id },
    create: { name: 'East', slug: 'east', parentId: karachi.id },
  });

  const south = await prisma.area.upsert({
    where: { slug: 'south' },
    update: { parentId: karachi.id },
    create: { name: 'South', slug: 'south', parentId: karachi.id },
  });

  const central = await prisma.area.upsert({
    where: { slug: 'central' },
    update: { parentId: karachi.id },
    create: { name: 'Central', slug: 'central', parentId: karachi.id },
  });

  const korangi = await prisma.area.upsert({
    where: { slug: 'korangi' },
    update: { parentId: karachi.id },
    create: { name: 'Korangi', slug: 'korangi', parentId: karachi.id },
  });

  // Areas (children of districts)
  await prisma.area.upsert({
    where: { slug: 'gulshan-e-iqbal' },
    update: { parentId: east.id },
    create: { name: 'Gulshan-e-Iqbal', slug: 'gulshan-e-iqbal', parentId: east.id },
  });

  await prisma.area.upsert({
    where: { slug: 'clifton' },
    update: { parentId: south.id },
    create: { name: 'Clifton', slug: 'clifton', parentId: south.id },
  });

  await prisma.area.upsert({
    where: { slug: 'north-nazimabad' },
    update: { parentId: central.id },
    create: { name: 'North Nazimabad', slug: 'north-nazimabad', parentId: central.id },
  });

  await prisma.area.upsert({
    where: { slug: 'korangi-town' },
    update: { parentId: korangi.id },
    create: { name: 'Korangi', slug: 'korangi-town', parentId: korangi.id },
  });

  // --- Staff accounts --------------------------------------------------------
  await prisma.user.upsert({
    where: { email: 'admin@kamyaab.pk' },
    update: {},
    create: {
      email: 'admin@kamyaab.pk',
      role: 'ADMIN',
    },
  });

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
