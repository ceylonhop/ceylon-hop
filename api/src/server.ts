import { serve } from '@hono/node-server';
import { app } from './app';

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port });
console.log(`Ceylon Hop API listening on http://localhost:${port}`);
