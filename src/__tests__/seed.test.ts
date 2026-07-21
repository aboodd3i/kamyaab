/**
 * Database schema and seed tests.
 *
 * These tests verify structural properties of the Prisma schema and
 * seed data without requiring a live database connection:
 *
 * - Required categories exist in seed
 * - Seed is idempotent (uses upsert/createMany skipDuplicates)
 * - Area parent-child relationships exist
 * - Worker userId is nullable
 * - Worker agentId relation works
 * - Prisma schema and migrations are consistent (file-level checks)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

// --- Schema reading ---------------------------------------------------------

const schemaPath = join(__dirname, '../../prisma/schema.prisma');
const schemaContent = readFileSync(schemaPath, 'utf-8');

const seedPath = join(__dirname, '../../prisma/seed.ts');
const seedContent = readFileSync(seedPath, 'utf-8');

const migrationsDir = join(__dirname, '../../prisma/migrations');

// --- Tests ------------------------------------------------------------------

describe('Prisma schema', () => {
  it('defines UserRole enum with CLIENT, AGENT, ADMIN', () => {
    expect(schemaContent).toContain('enum UserRole');
    expect(schemaContent).toContain('CLIENT');
    expect(schemaContent).toContain('AGENT');
    expect(schemaContent).toContain('ADMIN');
  });

  it('defines WorkerStatus enum with PENDING_APPROVAL, APPROVED, SUSPENDED', () => {
    expect(schemaContent).toContain('enum WorkerStatus');
    expect(schemaContent).toContain('PENDING_APPROVAL');
    expect(schemaContent).toContain('APPROVED');
    expect(schemaContent).toContain('SUSPENDED');
  });

  it('User model has authUserId as unique nullable', () => {
    expect(schemaContent).toContain('authUserId String?  @unique');
  });

  it('WorkerProfile.phone is unique', () => {
    expect(schemaContent).toMatch(/phone\s+String\s+@unique/);
  });

  it('WorkerProfile.userId is nullable', () => {
    // userId should be String? (nullable)
    expect(schemaContent).toMatch(/userId\s+String\?\s+@unique/);
  });

  it('WorkerProfile.agentId is nullable', () => {
    expect(schemaContent).toMatch(/agentId\s+String\?/);
  });

  it('WorkerProfile has suspensionReason', () => {
    expect(schemaContent).toContain('suspensionReason');
  });

  it('WorkerProfile has agent relation', () => {
    expect(schemaContent).toContain('AgentWorkerProfiles');
  });

  it('Area has hierarchical parent-child relation', () => {
    expect(schemaContent).toContain('AreaHierarchy');
    expect(schemaContent).toContain('parentId');
  });
});

describe('Seed data — categories', () => {
  const requiredCategories = [
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

  for (const category of requiredCategories) {
    it(`seeds category: ${category}`, () => {
      expect(seedContent).toContain(category);
    });
  }

  it('does not include obsolete categories Tailor and Cook in canonical list', () => {
    expect(seedContent).not.toContain("{ name: 'Tailor' }");
    expect(seedContent).not.toContain("{ name: 'Cook' }");
  });

  it('uses upsert for categories (idempotent)', () => {
    expect(seedContent).toContain('prisma.category.upsert');
  });
});

describe('Seed data — areas', () => {
  it('creates Karachi as root area', () => {
    expect(seedContent).toContain("'karachi'");
    expect(seedContent).toContain("'Karachi'");
  });

  it('creates districts as children of Karachi', () => {
    expect(seedContent).toContain("'east'");
    expect(seedContent).toContain("'south'");
    expect(seedContent).toContain("'central'");
    expect(seedContent).toContain("'korangi'");
  });

  it('creates areas as children of districts', () => {
    expect(seedContent).toContain("'gulshan-e-iqbal'");
    expect(seedContent).toContain("'clifton'");
    expect(seedContent).toContain("'north-nazimabad'");
    expect(seedContent).toContain("'korangi-town'");
  });

  it('uses upsert for areas (idempotent)', () => {
    expect(seedContent).toContain('area.upsert');
  });

  it('links children to parent via parentId', () => {
    expect(seedContent).toContain('parentId: karachi.id');
    expect(seedContent).toContain('parentId: east.id');
    expect(seedContent).toContain('parentId: south.id');
    expect(seedContent).toContain('parentId: central.id');
    expect(seedContent).toContain('parentId: korangi.id');
  });
});

describe('Seed data — staff accounts', () => {
  it('creates admin account', () => {
    expect(seedContent).toContain('admin@kamyaab.pk');
    expect(seedContent).toContain("'ADMIN'");
  });

  it('creates agent account', () => {
    expect(seedContent).toContain('agent1@kamyaab.pk');
    expect(seedContent).toContain("'AGENT'");
  });

  it('uses upsert for staff (idempotent)', () => {
    expect(seedContent).toContain('user.upsert');
  });
});

describe('Migrations', () => {
  it('migration directory exists', () => {
    expect(existsSync(migrationsDir)).toBe(true);
  });

  it('has init migration', () => {
    const initDir = join(migrationsDir, '20260720000000_init');
    expect(existsSync(join(initDir, 'migration.sql'))).toBe(true);
  });

  it('has authUserId migration', () => {
    const authDir = join(migrationsDir, '20260720010000_add_auth_user_id');
    expect(existsSync(join(authDir, 'migration.sql'))).toBe(true);
  });

  it('has phone unique + suspensionReason migration', () => {
    const workerDir = join(migrationsDir, '20260720020000_worker_phone_unique_and_suspension_reason');
    expect(existsSync(join(workerDir, 'migration.sql'))).toBe(true);
  });

  it('authUserId migration adds the column with unique index', () => {
    const migrationSql = readFileSync(
      join(migrationsDir, '20260720010000_add_auth_user_id', 'migration.sql'),
      'utf-8',
    );
    expect(migrationSql).toContain('ADD COLUMN "authUserId" TEXT');
    expect(migrationSql).toContain('User_authUserId_key');
  });

  it('worker migration adds phone unique index and suspensionReason', () => {
    const migrationSql = readFileSync(
      join(migrationsDir, '20260720020000_worker_phone_unique_and_suspension_reason', 'migration.sql'),
      'utf-8',
    );
    expect(migrationSql).toContain('WorkerProfile_phone_key');
    expect(migrationSql).toContain('suspensionReason');
  });

  it('all migration directories have migration.sql files', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const dir of dirs) {
      const migrationFile = join(migrationsDir, dir.name, 'migration.sql');
      expect(existsSync(migrationFile)).toBe(true);
    }
  });
});
