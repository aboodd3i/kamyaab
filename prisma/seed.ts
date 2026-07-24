import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // --- Categories (12 canonical categories) ---------------------------------
  const canonicalCategories = [
    'Electrician',
    'Plumber',
    'Carpenter',
    'Painter',
    'Gardener',
    'AC Technician',
    'Appliance Repair Technician',
    'Mason',
    'Welder',
    'Cleaner',
    'Driver',
    'General Handyman',
  ];

  // Create all canonical categories
  for (const categoryName of canonicalCategories) {
    await prisma.category.upsert({
      where: { name: categoryName },
      update: {}, // No update needed if exists
      create: { name: categoryName },
    });
  }

  // Safely remove obsolete categories only if they have no worker relationships
  const obsoleteCategories = ['Tailor', 'Cook'];
  for (const obsoleteName of obsoleteCategories) {
    // Check if category exists
    const category = await prisma.category.findUnique({
      where: { name: obsoleteName },
      include: { workers: true }, // Check WorkerCategory relationships
    });

    if (category) {
      if (category.workers.length === 0) {
        // Safe to delete - no worker relationships
        await prisma.category.delete({
          where: { id: category.id },
        });
        console.log(`Deleted unreferenced obsolete category: ${obsoleteName}`);
      } else {
        // Category has worker relationships - keep it
        console.warn(
          `Retaining obsolete category "${obsoleteName}" because it has ${category.workers.length} worker relationship(s)`
        );
      }
    }
  }

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
