/**
 * Staff provisioning script.
 *
 * Creates AGENT and ADMIN accounts in BOTH Supabase Auth and the
 * PostgreSQL User table, linking them via `authUserId`.
 *
 * Idempotent: if the Supabase Auth user already exists, it is skipped
 * (signInWithPassword is not retried).  If the Prisma row already
 * exists, it is updated with the `authUserId` link.
 *
 * Credentials are read from environment variables — never hard-coded:
 *
 *   ADMIN_EMAIL=admin@kamyaab.pk
 *   ADMIN_PASSWORD=...
 *   AGENT1_EMAIL=agent1@kamyaab.pk
 *   AGENT1_PASSWORD=...
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (the service-role client bypasses
 * email confirmation and can create users without restrictions).
 *
 * Usage:  npm run seed:auth
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// --- Validation -------------------------------------------------------------

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const databaseUrl = process.env.DATABASE_URL;

if (!supabaseUrl || !serviceRoleKey || !databaseUrl) {
  console.error(
    'Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL\n' +
      'Set them in your .env file before running this script.',
  );
  process.exit(1);
}

// --- Clients ----------------------------------------------------------------

const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });

// --- Staff definitions ------------------------------------------------------

interface StaffDef {
  email: string;
  password: string;
  role: 'AGENT' | 'ADMIN';
}

function getStaffList(): StaffDef[] {
  const staff: StaffDef[] = [];

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@kamyaab.pk';
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    staff.push({ email: adminEmail, password: adminPassword, role: 'ADMIN' });
  }

  const agentEmail = process.env.AGENT1_EMAIL || 'agent1@kamyaab.pk';
  const agentPassword = process.env.AGENT1_PASSWORD;
  if (agentPassword) {
    staff.push({ email: agentEmail, password: agentPassword, role: 'AGENT' });
  }

  return staff;
}

// --- Provisioning logic -----------------------------------------------------

async function provisionStaff(staff: StaffDef): Promise<void> {
  const { email, password, role } = staff;

  // 1. Check if the Supabase Auth user already exists
  const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
  const existing = existingUsers?.users?.find((u) => u.email === email);

  let authUserId: string;

  if (existing) {
    authUserId = existing.id;
    console.log(`  ✓ Supabase Auth user already exists: ${email}`);
  } else {
    // Create the Supabase Auth user with the service-role client
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // bypass email confirmation
    });

    if (error) {
      throw new Error(`Failed to create Supabase Auth user ${email}: ${error.message}`);
    }

    authUserId = data.user.id;
    console.log(`  + Created Supabase Auth user: ${email}`);
  }

  // 2. Upsert the Prisma User row, linking via authUserId
  await prisma.user.upsert({
    where: { authUserId },
    update: { email, role },
    create: {
      authUserId,
      email,
      role,
    },
  });

  console.log(`  + Linked Prisma User row: ${email} (${role}) → authUserId ${authUserId}`);
}

// --- Main -------------------------------------------------------------------

async function main() {
  const staffList = getStaffList();

  if (staffList.length === 0) {
    console.log(
      'No staff passwords found in env.\n' +
        'Set ADMIN_PASSWORD and/or AGENT1_PASSWORD to provision staff accounts.',
    );
    return;
  }

  console.log(`Provisioning ${staffList.length} staff account(s)…\n`);

  for (const staff of staffList) {
    console.log(`→ ${staff.email} (${staff.role})`);
    await provisionStaff(staff);
    console.log();
  }

  console.log('Staff provisioning complete.');
}

main()
  .catch((e) => {
    console.error('Provisioning failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
