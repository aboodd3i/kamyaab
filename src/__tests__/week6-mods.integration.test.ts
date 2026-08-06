/**
 * Week 6 Mods — ADMIN_ASSIGNMENT + jobRequestId Integration Tests
 *
 * Tests that:
 *   1. AuditLog can be created with jobRequestId
 *   2. AuditLog can be created with ADMIN_ASSIGNMENT action
 *   3. AuditLog DTO includes jobRequestId
 *   4. AuditLog can be filtered by jobRequestId via index
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
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { logAction, listAuditLogs } from '../services/auditService';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const rawClient = new pg.Client({ connectionString: process.env.DATABASE_URL! });

const NS = randomUUID();
const PREFIX = `__test_${NS.substring(0, 8)}`;

const tempUserIds: string[] = [];
const tempAuditLogIds: string[] = [];

async function createTempUser(): Promise<string> {
  const idx = tempUserIds.length;
  const user = await prisma.user.create({
    data: {
      phone: `${PREFIX}-user-${idx}`,
      role: 'ADMIN',
    },
    select: { id: true },
  });
  tempUserIds.push(user.id);
  return user.id;
}

describe.skipIf(!RUN_GATE || IS_PROD)('Week 6 Mods — ADMIN_ASSIGNMENT + jobRequestId', () => {
  beforeAll(async () => {
    await rawClient.connect();
  });

  afterAll(async () => {
    if (tempAuditLogIds.length > 0) {
      await rawClient.query(`DELETE FROM "AuditLog" WHERE "id" = ANY($1::text[])`, [tempAuditLogIds]);
    }
    if (tempUserIds.length > 0) {
      await rawClient.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [tempUserIds]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('1. logAction can create audit log with ADMIN_ASSIGNMENT action', async () => {
    const userId = await createTempUser();
    const jobRequestId = randomUUID();
    const workerId = randomUUID();

    await logAction({
      action: 'ADMIN_ASSIGNMENT',
      actorUserId: userId,
      jobRequestId,
      workerId,
      summary: 'Admin manually assigned worker to job',
      metadata: { workerId, jobRequestId },
    });

    // Verify the log was created
    const logs = await prisma.auditLog.findMany({
      where: {
        actorUserId: userId,
        action: 'ADMIN_ASSIGNMENT',
      },
      select: { id: true, jobRequestId: true, action: true },
    });

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const log = logs.find((l) => l.jobRequestId === jobRequestId);
    expect(log).toBeDefined();
    expect(log!.action).toBe('ADMIN_ASSIGNMENT');
    expect(log!.jobRequestId).toBe(jobRequestId);

    tempAuditLogIds.push(...logs.map((l) => l.id));
  });

  it('2. logAction can create audit log with jobRequestId set', async () => {
    const userId = await createTempUser();
    const jobRequestId = randomUUID();

    await logAction({
      action: 'INVITATION_RESPONDED',
      actorUserId: userId,
      jobRequestId,
      summary: 'Worker responded to invitation for job',
      metadata: { response: 'ACCEPTED' },
    });

    const log = await prisma.auditLog.findFirst({
      where: {
        actorUserId: userId,
        jobRequestId,
      },
      select: { id: true, jobRequestId: true },
    });

    expect(log).not.toBeNull();
    expect(log!.jobRequestId).toBe(jobRequestId);

    tempAuditLogIds.push(log!.id);
  });

  it('3. logAction works without jobRequestId (backward compatible)', async () => {
    const userId = await createTempUser();

    await logAction({
      action: 'WORKER_STATUS_CHANGED',
      actorUserId: userId,
      summary: 'Worker status changed',
    });

    const log = await prisma.auditLog.findFirst({
      where: {
        actorUserId: userId,
        action: 'WORKER_STATUS_CHANGED',
      },
      select: { id: true, jobRequestId: true },
    });

    expect(log).not.toBeNull();
    expect(log!.jobRequestId).toBeNull();

    tempAuditLogIds.push(log!.id);
  });

  it('4. listAuditLogs returns entries with jobRequestId in DTO', async () => {
    const userId = await createTempUser();
    const jobRequestId = randomUUID();

    await logAction({
      action: 'ADMIN_ASSIGNMENT',
      actorUserId: userId,
      jobRequestId,
      summary: 'Test admin assignment with jobRequestId',
    });

    const logs = await listAuditLogs({
      action: 'ADMIN_ASSIGNMENT',
      actorUserId: userId,
      limit: 10,
    });

    const log = logs.find((l) => l.jobRequestId === jobRequestId);
    expect(log).toBeDefined();
    expect(log!.jobRequestId).toBe(jobRequestId);
    expect(log!.action).toBe('ADMIN_ASSIGNMENT');

    // Clean up
    const dbLogs = await prisma.auditLog.findMany({
      where: { actorUserId: userId, action: 'ADMIN_ASSIGNMENT' },
      select: { id: true },
    });
    tempAuditLogIds.push(...dbLogs.map((l) => l.id));
  });
});
