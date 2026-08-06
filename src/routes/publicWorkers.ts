/**
 * Public worker discovery routes — search and detail.
 *
 * No authentication required. Only APPROVED workers are visible.
 * Uses the centralized publicWorkerDto for safe serialization.
 */

import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { sendSuccess, errors, ErrorCode } from '../lib/errors';
import { toPublicWorker } from '../lib/publicWorkerDto';
import { z } from 'zod';

const router = Router();

// ─── Validation ────────────────────────────────────────────────────────────

const SearchQuerySchema = z.object({
  categoryId: z.string().min(1).optional(),
  areaId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// ─── Prisma select for public worker queries ───────────────────────────────

const publicWorkerSelect = {
  id: true,
  name: true,
  status: true,
  rating: true,
  ratingCount: true,
  completedJobsCount: true,
  isPriorityListed: true,
  identityChecked: true,
  phoneConfirmed: true,
  referenceStatus: true,
  backgroundChecked: true,
  skillAssessed: true,
  categories: {
    select: {
      category: {
        select: { id: true, name: true },
      },
    },
  },
  serviceAreas: {
    select: {
      area: {
        select: { id: true, name: true, parentId: true },
      },
    },
  },
} as const;

// ─── Search ────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/workers
 *
 * Public endpoint. Returns only APPROVED workers.
 *
 * Query params:
 *   categoryId — optional filter
 *   areaId     — optional filter
 *   page       — default 1
 *   limit      — default 20, max 50
 *
 * Ordering: rating DESC, completedJobsCount DESC, id ASC
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw errors.badRequest(ErrorCode.VALIDATION_ERROR, 'Invalid query parameters');
    }

    const { categoryId, areaId, page, limit } = parsed.data;
    const skip = (page - 1) * limit;

    // Build the where clause — always require APPROVED status
    const where: Record<string, unknown> = { status: 'APPROVED' };

    if (categoryId) {
      where.categories = { some: { categoryId } };
    }
    if (areaId) {
      where.serviceAreas = { some: { areaId } };
    }

    const [workers, total] = await Promise.all([
      prisma.workerProfile.findMany({
        where,
        select: publicWorkerSelect,
        orderBy: [
          { isPriorityListed: 'desc' },
          { rating: 'desc' },
          { completedJobsCount: 'desc' },
          { id: 'asc' },
        ],
        skip,
        take: limit,
      }),
      prisma.workerProfile.count({ where }),
    ]);

    const data = workers.map(toPublicWorker);

    return sendSuccess(res, {
      data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Detail ────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/workers/:id
 *
 * Public endpoint. Returns a worker only if status is APPROVED.
 * Returns 404 for non-existent, pending, or suspended workers.
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const worker = await prisma.workerProfile.findUnique({
      where: { id },
      select: publicWorkerSelect,
    });

    // Return 404 for non-existent or non-approved workers.
    // Do not reveal that a non-approved worker exists.
    if (!worker || worker.status !== 'APPROVED') {
      throw errors.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker was not found');
    }

    return sendSuccess(res, toPublicWorker(worker));
  } catch (err) {
    next(err);
  }
});

export default router;
