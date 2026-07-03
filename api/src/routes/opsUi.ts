import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The Control Tower ops UI, served same-origin so it can call /admin/ops/* with the
// ch_ops session cookie and no CORS. Cached after the first successful read; a
// missing/unreadable file serves a minimal unavailable body rather than a bare 500 stack.
let cachedHtml: string | null = null;
function uiHtml(): string | null {
  if (cachedHtml) return cachedHtml;
  try {
    cachedHtml = readFileSync(fileURLToPath(new URL('./ops-ui.html', import.meta.url)), 'utf8');
    return cachedHtml;
  } catch (e) {
    console.error('opsUi: failed to read ops-ui.html', e);
    return null;
  }
}

export function opsUiRoutes(): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const html = uiHtml();
    if (html == null) return c.html('<h1>ops dashboard unavailable</h1>', 500);
    return c.html(html);
  });
  return app;
}
