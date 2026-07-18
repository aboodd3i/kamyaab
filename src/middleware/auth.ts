import { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import prisma from '../lib/prisma';

// Extend Express Request type to include the user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: string;
      };
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Missing or invalid token' });
    }

    const token = authHeader.split(' ')[1];

    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Get role from Prisma DB
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { role: true },
    });

    if (!dbUser) {
      return res.status(401).json({ success: false, message: 'User not found in database' });
    }

    req.user = {
      id: user.id,
      role: dbUser.role,
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error during authentication' });
  }
};
