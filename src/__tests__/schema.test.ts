import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read schema and migration files for static validation
const schemaPath = join(__dirname, '../../prisma/schema.prisma');
const schemaContent = readFileSync(schemaPath, 'utf-8');

const migrationPath = join(__dirname, '../../prisma/migrations/20260720030000_week3_worker_profile_search_schema/migration.sql');
const migrationContent = readFileSync(migrationPath, 'utf-8');

const initMigrationPath = join(__dirname, '../../prisma/migrations/20260720000000_init/migration.sql');
const initMigrationContent = readFileSync(initMigrationPath, 'utf-8');

const seedPath = join(__dirname, '../../prisma/seed.ts');
const seedContent = readFileSync(seedPath, 'utf-8');

describe('Week 3 Database Schema - Static Validation', () => {
  describe('ReferenceCheckStatus enum', () => {
    it('should have correct enum values in schema', () => {
      expect(schemaContent).toContain('enum ReferenceCheckStatus {');
      expect(schemaContent).toContain('UNVERIFIED');
      expect(schemaContent).toContain('CONTACTED');
      expect(schemaContent).toContain('CONFIRMED');
      expect(schemaContent).toContain('FAILED');
    });

    it('should have enum in migration', () => {
      expect(migrationContent).toContain('CREATE TYPE "ReferenceCheckStatus" AS ENUM');
      expect(migrationContent).toContain("'UNVERIFIED'");
      expect(migrationContent).toContain("'CONTACTED'");
      expect(migrationContent).toContain("'CONFIRMED'");
      expect(migrationContent).toContain("'FAILED'");
    });
  });

  describe('WorkerProfile authoritative reference fields', () => {
    it('should have reference fields on WorkerProfile', () => {
      expect(schemaContent).toContain('referenceName        String?');
      expect(schemaContent).toContain('referencePhone       String?');
      expect(schemaContent).toContain('referenceStatus      ReferenceCheckStatus @default(UNVERIFIED)');
      expect(schemaContent).toContain('referenceVerifiedById String?');
      expect(schemaContent).toContain('referenceVerifiedBy  User?');
      expect(schemaContent).toContain('referenceVerifiedAt  DateTime?');
    });

    it('should NOT have WorkerReference model', () => {
      expect(schemaContent).not.toContain('model WorkerReference {');
    });

    it('should NOT have references relationship on WorkerProfile', () => {
      expect(schemaContent).not.toMatch(/references\s+WorkerReference\[\]/);
    });

    it('should have referenceVerifiedBy with SET NULL on delete', () => {
      expect(schemaContent).toContain('onDelete: SetNull');
    });
  });

  describe('WorkerCategory join table', () => {
    it('should have composite primary key in schema', () => {
      expect(schemaContent).toContain('@@id([workerId, categoryId])');
    });

    it('should have categoryId index in schema', () => {
      expect(schemaContent).toContain('@@index([categoryId])');
    });

    it('should have cascade delete in schema', () => {
      expect(schemaContent).toContain('onDelete: Cascade');
    });

    it('should have composite primary key in migration', () => {
      expect(migrationContent).toContain('CONSTRAINT "worker_categories_pkey" PRIMARY KEY ("workerId","categoryId")');
    });

    it('should have categoryId index in migration', () => {
      expect(migrationContent).toContain('CREATE INDEX "worker_categories_categoryId_idx"');
    });
  });

  describe('WorkerServiceArea join table', () => {
    it('should have composite primary key in schema', () => {
      expect(schemaContent).toContain('@@id([workerId, areaId])');
    });

    it('should have areaId index in schema', () => {
      expect(schemaContent).toContain('@@index([areaId])');
    });

    it('should have cascade delete in schema', () => {
      expect(schemaContent).toContain('onDelete: Cascade');
    });

    it('should have composite primary key in migration', () => {
      expect(migrationContent).toContain('CONSTRAINT "worker_service_areas_pkey" PRIMARY KEY ("workerId","areaId")');
    });

    it('should have areaId index in migration', () => {
      expect(migrationContent).toContain('CREATE INDEX "worker_service_areas_areaId_idx"');
    });
  });

  describe('Search index', () => {
    it('should have composite search index in schema', () => {
      expect(schemaContent).toContain('@@index([status, rating(desc), completedJobsCount(desc)])');
    });

    it('should have search index in migration', () => {
      expect(migrationContent).toContain('CREATE INDEX "WorkerProfile_status_rating_completedJobsCount_idx"');
      expect(migrationContent).toContain('"rating" DESC');
      expect(migrationContent).toContain('"completedJobsCount" DESC');
    });
  });

  describe('Database CHECK constraints', () => {
    it('should have rating range constraint in migration', () => {
      expect(migrationContent).toContain('CONSTRAINT "WorkerProfile_rating_range_check"');
      expect(migrationContent).toContain('CHECK ("rating" >= 0 AND "rating" <= 5)');
    });

    it('should have ratingCount nonnegative constraint in migration', () => {
      expect(migrationContent).toContain('CONSTRAINT "WorkerProfile_ratingCount_nonnegative_check"');
      expect(migrationContent).toContain('CHECK ("ratingCount" >= 0)');
    });

    it('should have completedJobsCount nonnegative constraint in migration', () => {
      expect(migrationContent).toContain('CONSTRAINT "WorkerProfile_completedJobsCount_nonnegative_check"');
      expect(migrationContent).toContain('CHECK ("completedJobsCount" >= 0)');
    });
  });

  describe('Seed safety with relationships', () => {
    it('should check for worker relationships before deleting categories', () => {
      expect(seedContent).toContain('include: { workers: true }');
      expect(seedContent).toContain('category.workers.length === 0');
    });

    it('should not use deleteMany for category cleanup', () => {
      expect(seedContent).not.toContain('prisma.category.deleteMany');
    });

    it('should warn when retaining referenced obsolete categories', () => {
      expect(seedContent).toContain('console.warn');
      expect(seedContent).toContain('Retaining obsolete category');
    });

    it('should delete only unreferenced categories', () => {
      expect(seedContent).toContain('prisma.category.delete({');
      expect(seedContent).toContain('where: { id: category.id }');
    });
  });

  describe('No placeholder assertions', () => {
    it('should not contain placeholder assertions in test files', () => {
      // Check all test files for placeholder assertions
      const testFiles = [
        join(__dirname, 'schema.test.ts'),
        join(__dirname, 'seed.test.ts'),
        join(__dirname, '../lib/__tests__/phone.test.ts'),
        join(__dirname, '../middleware/__tests__/auth.test.ts'),
        join(__dirname, '../routes/__tests__/me.test.ts'),
        join(__dirname, '../routes/__tests__/workers.test.ts'),
        join(__dirname, '../services/__tests__/workerService.test.ts'),
      ];
      
      const placeholderPattern = /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/;
      
      for (const testFile of testFiles) {
        const content = readFileSync(testFile, 'utf-8');
        expect(content, `Test file ${testFile} contains placeholder assertions`).not.toMatch(placeholderPattern);
      }
    });
  });

  describe('WorkerProfile table-mapping consistency', () => {
    it('should not map WorkerProfile to worker_profiles', () => {
      expect(schemaContent).not.toContain('@@map("worker_profiles")');
    });

    it('should create "WorkerProfile" in the initial migration', () => {
      expect(initMigrationContent).toContain('CREATE TABLE "WorkerProfile"');
    });

    it('should alter "WorkerProfile" in the Week 3 migration', () => {
      expect(migrationContent).toContain('ALTER TABLE "WorkerProfile"');
    });

    it('should not create or rename a worker_profiles table in the Week 3 migration', () => {
      expect(migrationContent).not.toContain('worker_profiles');
    });
  });
});