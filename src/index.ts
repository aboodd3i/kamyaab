import express, { Request, Response } from 'express';
import authRoutes from './routes/auth';
import workerRoutes from './routes/workers';

const app = express();
const PORT = 3000;

app.use(express.json());

app.use('/auth', authRoutes);
app.use('/api/v1/workers', workerRoutes);

app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Welcome to the Kamyaab Backend API!', version: '1.0' });
});

app.get('/ping', (_req: Request, res: Response) => {
  res.json({ message: 'pong', status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
