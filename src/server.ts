import 'dotenv/config';
import { createApp } from './app';
import { env } from './config/env';
import { startExpiryJob } from './jobs/expiryJob';

const app = createApp();

startExpiryJob();

app.listen(env.port, () => {
  console.log(`Server running on http://localhost:${env.port} [${env.nodeEnv}]`);
});
