/**
 * Public catalog routes — categories and areas.
 *
 * No authentication required. Returns only safe public fields.
 */

import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { sendSuccess } from '../lib/errors';
import { errors, ErrorCode } from '../lib/errors';

const router = Router();

/**
 * GET /api/v1/categories
 *
 * Public endpoint. Returns all categories sorted by name ascending.
 * Returns only id and name.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
      },
    });

    return sendSuccess(res, categories);
  } catch (err) {
    next(err);
  }
});

export default router;
