import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
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

  it('gzip-compresses the /ops shell for clients that accept it', async () => {
    const app = createApp();
    const res = await app.request('/ops', { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    // Body is genuinely gzip-encoded — decode it to confirm it's the real shell (and
    // much smaller on the wire: the ~190KB shell compresses to well under a third).
    const gz = Buffer.from(await res.arrayBuffer());
    const body = gunzipSync(gz).toString('utf8');
    expect(body).toContain('Ceylon Hop');
    expect(body).toContain('id="quoteRoot"');
    expect(gz.length).toBeLessThan(body.length / 2);
  });

  it('serves the shell uncompressed to clients that do not accept gzip', async () => {
    const app = createApp();
    const res = await app.request('/ops'); // no accept-encoding
    expect(res.headers.get('content-encoding')).toBeNull();
    expect((await res.text())).toContain('Ceylon Hop');
  });

  it('wires teardown, deep-linking, and focus handling on the merged ops+quote shell (T6)', async () => {
    const app = createApp();
    const res = await app.request('/ops');
    const body = await res.text();
    expect(body).toContain('QuoteView.teardown()'); // logout tears down the quote module (no stale beforeunload)
    expect(body).toContain("location.hash==='#quote'"); // boot sequence deep-links a founder into the quote view
    expect(body).toContain('_lastRenderedRoute'); // focus only moves on an actual route transition
  });
});
