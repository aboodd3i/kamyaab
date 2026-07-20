import express, { Request, Response } from 'express';
import authRoutes from './routes/auth';
import workerRoutes from './routes/workers';

/**
 * Express application factory.
 *
 * Separated from server startup so that tests can import `app`
 * without binding a port.
 */
export function createApp() {
  const app = express();

  app.use(express.json());

  app.use('/auth', authRoutes);
  app.use('/api/v1/workers', workerRoutes);

  app.get('/', (_req: Request, res: Response) => {
    res.json({ message: 'Welcome to the Kamyaab Backend API!', version: '1.0' });
  });

  app.get('/ping', (_req: Request, res: Response) => {
    res.json({ message: 'pong', status: 'ok' });
  });

  return app;
}
