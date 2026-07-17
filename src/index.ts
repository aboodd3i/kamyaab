import express, { Request, Response } from 'express';

const app = express();
const PORT = 3000;

app.get('/ping', (_req: Request, res: Response) => {
  res.json({ message: 'pong', status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
