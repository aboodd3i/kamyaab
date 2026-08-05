import express, { Request, Response } from 'express';
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import workerRoutes from './routes/workers';
import publicWorkerRoutes from './routes/publicWorkers';
import categoryRoutes from './routes/categories';
import areaRoutes from './routes/areas';
import jobRequestRoutes from './routes/jobRequests';
import invitationRoutes from './routes/invitations';
import availabilityRoutes from './routes/availability';
import { errorMiddleware } from './lib/errors';

/**
 * Express application factory.
 *
 * Separated from server startup so that tests can import `app`
 * without binding a port.
 */
export function createApp() {
  const app = express();

  app.use(express.json());

  // Health checks (no auth required)
  app.get('/', (_req: Request, res: Response) => {
    res.json({ message: 'Welcome to the Kamyaab Backend API!', version: '1.0' });
  });

  app.get('/ping', (_req: Request, res: Response) => {
    res.json({ message: 'pong', status: 'ok' });
  });

  // Public catalog routes (no auth required)
  app.use('/api/v1/categories', categoryRoutes);
  app.use('/api/v1/areas', areaRoutes);

  // Public worker discovery routes (no auth required)
  app.use('/api/v1/workers', publicWorkerRoutes);

  // API routes (auth required)
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/me', meRoutes);
  app.use('/api/v1/workers', workerRoutes);
  app.use('/api/v1/job-requests', jobRequestRoutes);
  app.use('/api/v1/invitations', invitationRoutes);
  app.use('/api/v1/availability', availabilityRoutes);

  // Centralized error handler — must be registered last
  app.use(errorMiddleware);

  return app;
}
