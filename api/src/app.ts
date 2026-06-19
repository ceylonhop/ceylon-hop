import { Hono } from 'hono';

// The application surface. Routes are mounted here so tests can exercise the app
// in-process via `app.request(...)` without binding a port (see app.test.ts).
export const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));
