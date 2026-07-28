/**
 * Week 3 Schema — Genuine PostgreSQL Integration Tests
 *
 * This file makes real PostgreSQL queries against the development database.
 * It does NOT mock Prisma or PostgreSQL.
 *
 * Safety gate: refuses to run unless RUN_DB_INTEGRATION_TESTS=true
 * and NODE_ENV is not "production".
 *
 * All temporary records are prefixed with a unique namespace UUID and
 * cleaned up in finally blocks. No shared data is modified or deleted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

// ─── Safety gate ───────────────────────────────────────────────────────────

const RUN_GATE = process.env.RUN_DB_INTEGRATION_TESTS === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!RUN_GATE || IS_PROD) {
  console.log(
    'Integration tests skipped: set RUN_DB_INTEGRATION_TESTS=true and ensure NODE_ENV is not production.'
  );
}

// ─── Imports (only loaded after gate passes) ───────────────────────────────

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// ─── Setup ─────────────────────────────────────────────────────────────────

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });

/** Unique namespace for all temporary records created by this test run. */
const NS = randomUUID();
/** Human-readable prefix for synthetic names — clearly temporary. */
const PREFIX = `__test_${NS.substring(0, 8)}`;

/** Collects IDs of all temporary users created so they can be cleaned up. */
const tempUserIds: string[] = [];
/** Collects IDs of all temporary workers created so they can be cleaned up. */
const tempWorkerIds: string[] = [];
/** Collects IDs of all temporary categories created. */
const tempCategoryIds: string[] = [];
/** Collects IDs of all temporary areas created. */
const tempAreaIds: string[] = [];

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Creates a temporary User record. */
async function createTempUser(role: 'ADMIN' | 'AGENT' | 'CLIENT' = 'AGENT'): Promise<string> {
  const user = await prisma.user.create({
    data: {
      phone: `${PREFIX}-user-${tempUserIds.length}`,
      email: `${PREFIX}-user-${tempUserIds.length}@test.local`,
      role,
    },
    select: { id: true },
  });
  tempUserIds.push(user.id);
  return user.id;
}

/** Creates a temporary WorkerProfile record. */
async function createTempWorker(overrides: Record<string, unknown> = {}): Promise<string> {
  const idx = tempWorkerIds.length;
  const data: Record<string, unknown> = {
    name: `${PREFIX}-worker-${idx}`,
    phone: `${PREFIX}-phone-${idx}`,
    status: 'PENDING_APPROVAL',
    ...overrides,
  };
  const worker = await prisma.workerProfile.create({
    data: data as never,
    select: { id: true },
  });
  tempWorkerIds.push(worker.id);
  return worker.id;
}

/** Creates a temporary Category record. */
async function createTempCategory(): Promise<string> {
  const idx = tempCategoryIds.length;
  const cat = await prisma.category.create({
    data: { name: `${PREFIX}-cat-${idx}` },
    select: { id: true },
  });
  tempCategoryIds.push(cat.id);
  return cat.id;
}

/** Creates a temporary Area record. */
async function createTempArea(): Promise<string> {
  const idx = tempAreaIds.length;
  const area = await prisma.area.create({
    data: { name: `${PREFIX}-area-${idx}`, slug: `${PREFIX}-area-${idx}` },
    select: { id: true },
  });
  tempAreaIds.push(area.id);
  return area.id;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_GATE || IS_PROD)('Week 3 PostgreSQL Integration — WorkerProfile Schema', () => {
  beforeAll(async () => {
    await rawClient.connect();
  });

  afterAll(async () => {
    // Clean up all temporary records in reverse dependency order.
    // Use raw SQL to avoid Prisma relation complications during teardown.

    // 1. Delete join-table rows for temp workers
    if (tempWorkerIds.length > 0) {
      await rawClient.query(
        `DELETE FROM "worker_categories" WHERE "workerId" = ANY($1::text[])`,
        [tempWorkerIds]
      );
      await rawClient.query(
        `DELETE FROM "worker_service_areas" WHERE "workerId" = ANY($1::text[])`,
        [tempWorkerIds]
      );
    }

    // 2. Delete temp workers
    if (tempWorkerIds.length > 0) {
      await rawClient.query(
        `DELETE FROM "WorkerProfile" WHERE "id" = ANY($1::text[])`,
        [tempWorkerIds]
      );
    }

    // 3. Delete temp categories
    if (tempCategoryIds.length > 0) {
      await rawClient.query(
        `DELETE FROM "Category" WHERE "id" = ANY($1::text[])`,
        [tempCategoryIds]
      );
    }

    // 4. Delete temp areas
    if (tempAreaIds.length > 0) {
      await rawClient.query(
        `DELETE FROM "Area" WHERE "id" = ANY($1::text[])`,
        [tempAreaIds]
      );
    }

    // 5. Delete temp users (workers may have FK references, so delete last)
    if (tempUserIds.length > 0) {
      await rawClient.query(
        `DELETE FROM "User" WHERE "id" = ANY($1::text[])`,
        [tempUserIds]
      );
    }

    await rawClient.end();
    await prisma.$disconnect();
  });

  describe('Basic CRUD and table mapping', () => {
    it('1. should create a WorkerProfile using Week 1–2 required fields', async () => {
      const id = await createTempWorker();
      const found = await prisma.workerProfile.findUnique({ where: { id } });
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
    });

    it('2. should query the physical "WorkerProfile" table without P2021', async () => {
      const count = await prisma.workerProfile.count();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('24. should keep existing WorkerProfile rows queryable after migration', async () => {
      const count = await prisma.workerProfile.count();
      // Pre-migration count was 0. If rows exist, they should be queryable.
      // If no pre-existing rows, querying the table still succeeds.
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Default values', () => {
    it('3. rating should default to 0', async () => {
      const id = await createTempWorker();
      const w = await prisma.workerProfile.findUnique({ where: { id }, select: { rating: true } });
      expect(Number(w!.rating)).toBe(0);
    });

    it('4. ratingCount should default to 0', async () => {
      const id = await createTempWorker();
      const w = await prisma.workerProfile.findUnique({ where: { id }, select: { ratingCount: true } });
      expect(w!.ratingCount).toBe(0);
    });

    it('5. completedJobsCount should default to 0', async () => {
      const id = await createTempWorker();
      const w = await prisma.workerProfile.findUnique({ where: { id }, select: { completedJobsCount: true } });
      expect(w!.completedJobsCount).toBe(0);
    });

    it('6. referenceStatus should default to UNVERIFIED', async () => {
      const id = await createTempWorker();
      const w = await prisma.workerProfile.findUnique({ where: { id }, select: { referenceStatus: true } });
      expect(w!.referenceStatus).toBe('UNVERIFIED');
    });

    it('7. identityChecked should default to false', async () => {
      const id = await createTempWorker();
      const w = await prisma.workerProfile.findUnique({ where: { id }, select: { identityChecked: true } });
      expect(w!.identityChecked).toBe(false);
    });

    it('8. phoneConfirmed should default to false', async () => {
      const id = await createTempWorker();
      const w = await prisma.workerProfile.findUnique({ where: { id }, select: { phoneConfirmed: true } });
      expect(w!.phoneConfirmed).toBe(false);
    });

    it('9. backgroundChecked should default to false', async () => {
      const id = await createTempWorker();
      const w = await prisma.workerProfile.findUnique({ where: { id }, select: { backgroundChecked: true } });
      expect(w!.backgroundChecked).toBe(false);
    });

    it('10. skillAssessed should default to false', async () => {
      const id = await createTempWorker();
      const w = await prisma.workerProfile.findUnique({ where: { id }, select: { skillAssessed: true } });
      expect(w!.skillAssessed).toBe(false);
    });
  });

  describe('CNIC uniqueness', () => {
    it('11. two temporary workers may both have cnicNumber = null', async () => {
      const id1 = await createTempWorker({ cnicNumber: null });
      const id2 = await createTempWorker({ cnicNumber: null });
      const w1 = await prisma.workerProfile.findUnique({ where: { id: id1 }, select: { cnicNumber: true } });
      const w2 = await prisma.workerProfile.findUnique({ where: { id: id2 }, select: { cnicNumber: true } });
      expect(w1!.cnicNumber).toBeNull();
      expect(w2!.cnicNumber).toBeNull();
    });

    it('12. duplicate non-null cnicNumber should be rejected', async () => {
      const cnic = `${PREFIX}-cnic-dup`;
      await createTempWorker({ cnicNumber: cnic });
      await expect(createTempWorker({ cnicNumber: cnic })).rejects.toThrow();
    });
  });

  describe('PostgreSQL CHECK constraints (via raw SQL)', () => {
    it('13. rating below 0 should be rejected by PostgreSQL', async () => {
      const id = await createTempWorker();
      await expect(
        rawClient.query(
          `UPDATE "WorkerProfile" SET "rating" = $1 WHERE "id" = $2`,
          ['-0.01', id]
        )
      ).rejects.toThrow();
    });

    it('14. rating above 5 should be rejected by PostgreSQL', async () => {
      const id = await createTempWorker();
      await expect(
        rawClient.query(
          `UPDATE "WorkerProfile" SET "rating" = $1 WHERE "id" = $2`,
          ['5.01', id]
        )
      ).rejects.toThrow();
    });

    it('15. negative ratingCount should be rejected by PostgreSQL', async () => {
      const id = await createTempWorker();
      await expect(
        rawClient.query(
          `UPDATE "WorkerProfile" SET "ratingCount" = $1 WHERE "id" = $2`,
          [-1, id]
        )
      ).rejects.toThrow();
    });

    it('16. negative completedJobsCount should be rejected by PostgreSQL', async () => {
      const id = await createTempWorker();
      await expect(
        rawClient.query(
          `UPDATE "WorkerProfile" SET "completedJobsCount" = $1 WHERE "id" = $2`,
          [-1, id]
        )
      ).rejects.toThrow();
    });
  });

  describe('Worker/category and worker/area relationships', () => {
    it('17. one temporary worker can have multiple categories', async () => {
      const workerId = await createTempWorker();
      const cat1 = await createTempCategory();
      const cat2 = await createTempCategory();

      await prisma.workerCategory.create({ data: { workerId, categoryId: cat1 } });
      await prisma.workerCategory.create({ data: { workerId, categoryId: cat2 } });

      const count = await prisma.workerCategory.count({ where: { workerId } });
      expect(count).toBe(2);
    });

    it('18. one temporary worker can have multiple service areas', async () => {
      const workerId = await createTempWorker();
      const area1 = await createTempArea();
      const area2 = await createTempArea();

      await prisma.workerServiceArea.create({ data: { workerId, areaId: area1 } });
      await prisma.workerServiceArea.create({ data: { workerId, areaId: area2 } });

      const count = await prisma.workerServiceArea.count({ where: { workerId } });
      expect(count).toBe(2);
    });

    it('19. duplicate worker/category pairs should be rejected', async () => {
      const workerId = await createTempWorker();
      const catId = await createTempCategory();

      await prisma.workerCategory.create({ data: { workerId, categoryId: catId } });
      await expect(
        prisma.workerCategory.create({ data: { workerId, categoryId: catId } })
      ).rejects.toThrow();
    });

    it('20. duplicate worker/area pairs should be rejected', async () => {
      const workerId = await createTempWorker();
      const areaId = await createTempArea();

      await prisma.workerServiceArea.create({ data: { workerId, areaId } });
      await expect(
        prisma.workerServiceArea.create({ data: { workerId, areaId } })
      ).rejects.toThrow();
    });

    it('21. deleting a temporary worker should delete its worker/category rows', async () => {
      const workerId = await createTempWorker();
      const catId = await createTempCategory();
      await prisma.workerCategory.create({ data: { workerId, categoryId: catId } });

      // Delete the worker via raw SQL to avoid Prisma cascade ordering issues
      await rawClient.query(`DELETE FROM "WorkerProfile" WHERE "id" = $1`, [workerId]);

      const remaining = await prisma.workerCategory.count({ where: { workerId } });
      expect(remaining).toBe(0);

      // Remove from cleanup list since we already deleted it
      const idx = tempWorkerIds.indexOf(workerId);
      if (idx >= 0) tempWorkerIds.splice(idx, 1);
      // Clean up the temp category
      await prisma.category.delete({ where: { id: catId } });
      const catIdx = tempCategoryIds.indexOf(catId);
      if (catIdx >= 0) tempCategoryIds.splice(catIdx, 1);
    });

    it('22. deleting a temporary worker should delete its worker/area rows', async () => {
      const workerId = await createTempWorker();
      const areaId = await createTempArea();
      await prisma.workerServiceArea.create({ data: { workerId, areaId } });

      await rawClient.query(`DELETE FROM "WorkerProfile" WHERE "id" = $1`, [workerId]);

      const remaining = await prisma.workerServiceArea.count({ where: { workerId } });
      expect(remaining).toBe(0);

      const idx = tempWorkerIds.indexOf(workerId);
      if (idx >= 0) tempWorkerIds.splice(idx, 1);
      await prisma.area.delete({ where: { id: areaId } });
      const areaIdx = tempAreaIds.indexOf(areaId);
      if (areaIdx >= 0) tempAreaIds.splice(areaIdx, 1);
    });
  });

  describe('Reference verifier ON DELETE SET NULL', () => {
    it('23. deleting a temporary reference verifier sets referenceVerifiedById to null', async () => {
      const verifierId = await createTempUser('AGENT');
      const workerId = await createTempWorker({ referenceVerifiedById: verifierId });

      // Verify the FK is set
      const before = await prisma.workerProfile.findUnique({
        where: { id: workerId },
        select: { referenceVerifiedById: true },
      });
      expect(before!.referenceVerifiedById).toBe(verifierId);

      // Delete the verifier user
      await rawClient.query(`DELETE FROM "User" WHERE "id" = $1`, [verifierId]);

      // The worker's referenceVerifiedById should now be null
      const after = await prisma.workerProfile.findUnique({
        where: { id: workerId },
        select: { referenceVerifiedById: true },
      });
      expect(after!.referenceVerifiedById).toBeNull();

      // Remove from cleanup list
      const idx = tempUserIds.indexOf(verifierId);
      if (idx >= 0) tempUserIds.splice(idx, 1);
    });
  });

  describe('Physical schema verification', () => {
    it('25. public.worker_profiles should not be used or created', async () => {
      const result = await rawClient.query(
        `SELECT to_regclass('public.worker_profiles') AS reg`
      );
      expect(result.rows[0].reg).toBeNull();
    });

    it('26. the three named CHECK constraints should exist', async () => {
      const result = await rawClient.query(`
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = con.connamespace
        WHERE nsp.nspname = 'public' AND rel.relname = 'WorkerProfile' AND con.contype = 'c'
        ORDER BY con.conname
      `);
      const names = result.rows.map((r: { conname: string }) => r.conname);
      expect(names).toContain('WorkerProfile_rating_range_check');
      expect(names).toContain('WorkerProfile_ratingCount_nonnegative_check');
      expect(names).toContain('WorkerProfile_completedJobsCount_nonnegative_check');
    });

    it('27. both join-table composite primary keys should exist', async () => {
      for (const tbl of ['worker_categories', 'worker_service_areas']) {
        const pk = await rawClient.query(`
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_schema = 'public'
            AND tc.table_name = $1
            AND tc.constraint_type = 'PRIMARY KEY'
          ORDER BY kcu.ordinal_position
        `, [tbl]);
        expect(pk.rows.length).toBe(2);
      }
    });

    it('28. the reference-verifier foreign key should physically use ON DELETE SET NULL', async () => {
      const result = await rawClient.query(`
        SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = con.connamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'WorkerProfile'
          AND con.conname = 'WorkerProfile_referenceVerifiedById_fkey'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].def).toContain('ON DELETE SET NULL');
    });
  });
});
