import express, { Request, Response } from 'express';
import authRoutes from './routes/auth';
import workerRoutes from './routes/workers';

/**
 * Legacy entry point — delegates to createApp() from src/app.ts.
 * Prefer importing `createApp` directly in new code and tests.
 */
import { createApp } from './app';

const app = createApp();
const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
