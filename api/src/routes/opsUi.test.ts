import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

describe('ops UI shell', () => {
  it('serves the ops UI shell without auth', async () => {
    const app = createApp();
    const res = await app.request('/ops');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Ceylon Hop');
    expect(body).toContain('/admin/ops'); // wired to the real API, not mock data
    expect(body).not.toContain('CH-TMRJR'); // no mock bookings shipped
  });

  it('ships the founder-only Quote nav scaffold', async () => {
    const app = createApp();
    const res = await app.request('/ops');
    const body = await res.text();
    expect(body).toContain('data-route="quote"'); // Quote nav button rendered by script
    expect(body).toContain("state.role==='founder'"); // founder gate in the script
    expect(body).toContain('id="quoteRoot"'); // scoped quote container in .main
  });
});
