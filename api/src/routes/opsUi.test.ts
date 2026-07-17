import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createApp } from '../app';

describe('ops UI shell', () => {
  it('serves the ops UI shell without auth', async () => {
    const app = createApp();
    const res = await app.request('/ops');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
    const body = await res.text();
    expect(body).toContain('Ceylon Hop');
    expect(body).toContain('/admin/ops'); // wired to the real API, not mock data
    expect(body).not.toContain('CH-TMRJR'); // no mock bookings shipped
  });

  it('ships the merged Quotes queue nav gated on the quote:manage capability (D-A: all 3 roles)', async () => {
    const app = createApp();
    const res = await app.request('/ops');
    const body = await res.text();
    // Merged surface: one Quotes queue nav item (the builder is a detail view reached from it),
    // so the old separate "Generate Quote" (data-route="quote") nav button is gone.
    expect(body).toContain('data-route="quotes"'); // Quotes queue nav button rendered by script
    expect(body).not.toContain('data-route="quote"'); // no separate builder nav tab anymore
    expect(body).toContain("state.caps.includes('quote:manage')"); // capability gate, not a hardcoded role
    expect(body).not.toContain("state.role==='founder'"); // no leftover hardcoded founder gate
    expect(body).not.toContain("role!=='founder'");
    expect(body).toContain('id="quoteRoot"'); // scoped quote container in .main
    // The maker-checker gate reaches the client: the approve capability is exposed and used.
    expect(body).toContain("viewerCan('quote:approve')");
  });

  it('serves a Google Identity Services login (no password key field)', async () => {
    const app = createApp();
    const res = await app.request('/ops');
    const body = await res.text();
    expect(body).toContain('https://accounts.google.com/gsi/client'); // GIS script tag
    expect(body).toContain('id="g_id_signin"'); // GIS button mount point
    expect(body).not.toContain('id="loginkey"'); // password key field is gone
    expect(body).not.toContain('type="password"');
    expect(body).toContain("fetch('/admin/ops/login'"); // still posts to the same login route
    expect(body).toContain('credential:'); // posts {credential} (Google ID token), not {key}
  });

  it('renders the Google button on GIS script load, not only at boot (async race)', async () => {
    // The GIS client script is async — a one-shot boot-time `if(window.google)` check races
    // it and usually loses (blank login card). The button must (re)render from the script's onload.
    const app = createApp();
    const body = await (await app.request('/ops')).text();
    expect(body).toContain('function initGoogleButton()');      // extracted, reusable renderer
    expect(body).toContain('onload="window.initGoogleButton');  // GIS script calls it on load
    expect(body).toContain('childElementCount>0');              // idempotent guard — render once
  });

  it('templates the real GOOGLE_OAUTH_CLIENT_ID into the served HTML', async () => {
    const app = createApp({ auth: { opsUsers: '', googleClientId: 'test-client-id-123.apps.googleusercontent.com', opsSessionSecret: 'sek' } });
    const res = await app.request('/ops');
    const body = await res.text();
    expect(body).toContain('test-client-id-123.apps.googleusercontent.com');
    expect(body).not.toContain('{{GOOGLE_CLIENT_ID}}'); // placeholder always replaced, even if empty
  });

  it('templates the browser maps key into the itinerary map (defaults to the website key)', async () => {
    const app = createApp({ mapsBrowserKey: 'AIzaTESTBROWSERKEY123' });
    const body = await (await app.request('/ops')).text();
    expect(body).toContain('AIzaTESTBROWSERKEY123'); // explicit override reaches the client
    expect(body).not.toContain('{{MAPS_KEY}}');       // placeholder always replaced
    // With no override it falls back to the shared website browser key — no separate config.
    const dflt = await (await createApp().request('/ops')).text();
    expect(dflt).toContain('AIzaSyDY-pFmqV4eIax2hhsdj96YD1c8Em-srCI');
    expect(dflt).not.toContain('{{MAPS_KEY}}');
  });

  it('shows the dev-login affordance only when dev bypass is enabled (non-production)', async () => {
    const devApp = createApp({ auth: { opsUsers: '', googleClientId: '', opsSessionSecret: 'sek' } });
    const devBody = await (await devApp.request('/ops')).text();
    expect(devBody).toContain('id="devloginbtn"');
    expect(devBody).toContain("fetch('/admin/ops/dev-login'");
    expect(devBody).not.toContain('{{DEV_LOGIN_ENABLED}}');
  });

  it('consumes whoami as {email, role, caps} — no more bare-role bootApp(role)', async () => {
    const app = createApp();
    const body = await (await app.request('/ops')).text();
    expect(body).toContain('function bootApp(identity)');
    expect(body).toContain('state.caps=identity.caps');
    expect(body).toContain('state.email=identity.email');
    expect(body).not.toContain('function bootApp(role)');
  });

  it("derives the rail avatar from the person's name/email, never the role", async () => {
    const app = createApp();
    const body = await (await app.request('/ops')).text();
    expect(body).toContain('function avatarInitials(');
    expect(body).toContain('avatarInitials(identity.name,identity.email)');
    expect(body).not.toContain('identity.role.slice(0,2)'); // the old role-initials avatar ("FO")
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
    expect(body).toContain("searchParams.get('quote')"); // shareable quote links reopen a specific quote
    expect(body).toContain("window.addEventListener('popstate'"); // browser navigation replays the route
    expect(body).toContain('ch-output-editor'); // ready-to-send output is editable in place before copying
    expect(body).toContain('toggleChauffeurUpsell'); // point-to-point customer drafts can append the chauffeur option
    expect(body).toContain('_lastRenderedRoute'); // focus only moves on an actual route transition
  });

  it('ships a client-error beacon so ops-dashboard JS errors are captured (M17 parity)', async () => {
    // The customer pages beacon uncaught JS errors to /errors/client; the ops UI did not, so a
    // render bug in the staff dashboard vanished silently. It must forward to the same sink.
    const app = createApp();
    const body = await (await app.request('/ops')).text();
    expect(body).toContain("addEventListener('error'");            // global error handler wired
    expect(body).toContain("addEventListener('unhandledrejection'"); // + promise rejections
    expect(body).toContain('/errors/client');                       // same sink as the customer pages
    expect(body).toContain('[ops-ui]');                             // tagged distinctly from customer errors
  });
});

// Quote intent (spec 2026-07-17): the submitter records what the CUSTOMER asked for, which the
// reviewer reads to know which options to focus on.
describe('ops UI — quote intent', () => {
  // These assert the SHELL SOURCE (the JS that builds the DOM), not the rendered DOM — the
  // data-req attribute values are concatenated at runtime, so only the option list is a literal
  // here. The rendered control is covered in the browser by web-tests/e2e.
  it('renders the "Customer asked for" control, unselected by default', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('Customer asked for');
    expect(body).toContain('data-action="setRequestedService"');
    expect(body).toContain("[['private', 'Point-to-point'], ['chauffeur', 'Chauffeur-guide'], ['both', 'Both']]");
    expect(body).toContain('requestedService: null'); // I4: never derived from the priced service
  });

  it('sends it on save and restores it on reopen', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('requestedService: state.requestedService');
    expect(body).toContain('tool.requestedService');
  });
});
