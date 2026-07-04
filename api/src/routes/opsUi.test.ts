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

  it('mounts the quote tool as an encapsulated module on the ops session (T5)', async () => {
    const app = createApp();
    const res = await app.request('/ops');
    const body = await res.text();
    expect(body).toContain('const QuoteView = (function ('); // quote JS closure-scoped, not top-level
    expect(body).toContain('QuoteView.init()'); // ops shell lazy-boots the module on Quote view
    expect(body).toContain("localStorage.removeItem('chAdminKey')"); // stale admin-key cleanup on ops boot
    // The admin-key era is gone: no key reads/writes, no header, no prompt retry,
    // and the quote render no longer targets the standalone page's #app node.
    expect(body).not.toContain("getItem('chAdminKey')");
    expect(body).not.toContain("setItem('chAdminKey')");
    expect(body).not.toContain('x-admin-key');
    expect(body).not.toContain('prompt(');
    expect(body).not.toContain("getElementById('app')");
    expect(body).toContain("querySelector('#quoteRoot .ch-app')"); // module renders into the ops container
  });
});
