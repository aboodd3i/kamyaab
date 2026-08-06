/**
 * Week 5 — Availability Endpoints Integration Tests
 *
 * Tests the worker availability self-service endpoints.
 *
 * Safety gate: refuses to run unless RUN_DB_INTEGRATION_TESTS=true
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

const RUN_GATE = process.env.RUN_DB_INTEGRATION_TESTS === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

if (!RUN_GATE || IS_PROD) {
  console.log('Integration tests skipped: set RUN_DB_INTEGRATION_TESTS=true');
}

import 'dotenv/config';
import { setAvailability, getAvailability } from '../services/availabilityService';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });

const NS = randomUUID();
const PREFIX = `__test_${NS.substring(0, 8)}`;

const tempWorkerIds: string[] = [];

async function createTempWorker(status: string = 'APPROVED'): Promise<string> {
  const idx = tempWorkerIds.length;
  const worker = await prisma.workerProfile.create({
    data: {
      name: `${PREFIX}-worker-${idx}`,
      phone: `${PREFIX}-wphone-${idx}`,
      status: status as never,
    },
    select: { id: true },
  });
  tempWorkerIds.push(worker.id);
  return worker.id;
}

describe.skipIf(!RUN_GATE || IS_PROD)('Week 5 — Availability Service Integration', () => {
  beforeAll(async () => {
    await rawClient.connect();
  });

  afterAll(async () => {
    if (tempWorkerIds.length > 0) {
      await rawClient.query(`DELETE FROM "WorkerAvailability" WHERE "workerId" = ANY($1::text[])`, [tempWorkerIds]);
      await rawClient.query(`DELETE FROM "WorkerProfile" WHERE "id" = ANY($1::text[])`, [tempWorkerIds]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('1. getAvailability returns UNKNOWN for worker with no availability record', async () => {
    const workerId = await createTempWorker();
    const result = await getAvailability(workerId);
    expect(result.status).toBe('UNKNOWN');
    expect(result.workerId).toBe(workerId);
  });

  it('2. setAvailability creates availability record via upsert', async () => {
    const workerId = await createTempWorker();
    const result = await setAvailability({
      workerId,
      status: 'AVAILABLE',
      updateSource: 'WORKER_PORTAL',
    });
    expect(result.status).toBe('AVAILABLE');
    expect(result.updateSource).toBe('WORKER_PORTAL');
    expect(result.busyUntil).toBeNull();
  });

  it('3. setAvailability updates existing record via upsert', async () => {
    const workerId = await createTempWorker();

    await setAvailability({
      workerId,
      status: 'AVAILABLE',
      updateSource: 'WORKER_PORTAL',
    });

    const updated = await setAvailability({
      workerId,
      status: 'BUSY',
      updateSource: 'WORKER_PORTAL',
      busyUntil: new Date('2026-12-31'),
    });

    expect(updated.status).toBe('BUSY');
    expect(updated.busyUntil).not.toBeNull();
  });

  it('4. getAvailability returns the set status after update', async () => {
    const workerId = await createTempWorker();

    await setAvailability({
      workerId,
      status: 'UNAVAILABLE',
      updateSource: 'WORKER_PORTAL',
    });

    const result = await getAvailability(workerId);
    expect(result.status).toBe('UNAVAILABLE');
  });

  it('5. setAvailability throws 404 for non-existent worker', async () => {
    await expect(
      setAvailability({
        workerId: randomUUID(),
        status: 'AVAILABLE',
        updateSource: 'WORKER_PORTAL',
      }),
    ).rejects.toThrow();
  });

  it('6. setAvailability throws 403 for non-APPROVED worker', async () => {
    const workerId = await createTempWorker('PENDING_APPROVAL');
    await expect(
      setAvailability({
        workerId,
        status: 'AVAILABLE',
        updateSource: 'WORKER_PORTAL',
      }),
    ).rejects.toThrow();
  });
});
