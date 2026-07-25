/**
 * Public area catalog route.
 *
 * No authentication required. Returns safe structured geographic data
 * for client filtering. Does not return exact client addresses.
 */

import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { sendSuccess } from '../lib/errors';

const router = Router();

/**
 * GET /api/v1/areas
 *
 * Public endpoint. Returns all areas with hierarchy information.
 * Returns only id, name, and parentId.
 * Sorted by name ascending for deterministic ordering.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const areas = await prisma.area.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        parentId: true,
      },
    });

    return sendSuccess(res, areas);
  } catch (err) {
    next(err);
  }
});

export default router;
