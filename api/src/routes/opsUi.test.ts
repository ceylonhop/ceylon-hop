import { describe, it, expect, beforeAll } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createApp } from '../app';
import { ALL_OPS_ACTIONS } from '../lib/opsAuth';

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

  // An open booking sheet is part of the address (2026-08-08). Refreshing with a sheet open used
  // to drop it and land the operator back on the bare queue.
  describe('the open booking sheet is addressable', () => {
    const uiBody = async () => await (await createApp().request('/ops')).text();

    it('reads and writes ?booking= alongside the existing ?quote=', async () => {
      const body = await uiBody();
      expect(body).toContain("searchParams.get('booking')");
      expect(body).toContain("url.searchParams.set('booking',bookingId)");
      expect(body).toContain("url.searchParams.delete('booking')");
    });

    // The half that is easy to leave out. Opening on arrival looks like the whole feature until
    // you press Back and the sheet is still sitting there over the queue.
    it('closes the sheet when the URL no longer names a booking', async () => {
      const body = await uiBody();
      expect(body).toContain("if(!next.routeBookingId)closeDetail('silent');");
    });

    // renderSheet() resolves its ticket out of `tickets`; opening before the queue lands finds
    // nothing, hides the sheet, and drops the deep link silently.
    it('waits for the queue before opening a deep-linked booking', async () => {
      const body = await uiBody();
      const fn = (body.split('async function resolveBookingDeepLink(')[1] ?? '').split('\nasync function')[0];
      expect(fn).toContain('await loadQueue()');
      expect(fn).toContain("openDetail(id,{fromUrl:true})");
      expect(fn.indexOf('await loadQueue()')).toBeLessThan(fn.indexOf('openDetail(id,{fromUrl:true})'));
      expect(fn.length).toBeLessThan(2000); // the slice is one function, not the rest of the file
    });

    // Boot reads the URL itself rather than going through applyRouteFromUrl, so it needs its own
    // call — otherwise a REFRESH keeps the address and drops the sheet, which is the whole bug.
    it('resolves the deep link on boot, not only on popstate', async () => {
      const body = await uiBody();
      expect(body).toContain('if(next.routeBookingId)void resolveBookingDeepLink(next.routeBookingId);');
      expect(body).toContain("if(next.routeBookingId&&next.routeBookingId!==state.detail)void resolveBookingDeepLink");
    });

    // Six copies of the same three statements became one. Every close must now also drop the
    // param, and a stray raw reset would leave the address describing a closed sheet.
    it('funnels every close through closeDetail', async () => {
      const body = await uiBody();
      expect(body).toContain('function closeDetail(mode)');
      expect(body).toContain("closeDetail('push')");   // operator-initiated: Back reopens
      expect(body).toContain("closeDetail('replace')"); // the booking went away underneath them
      expect(body).toContain("closeDetail('silent')");  // caller syncs the URL itself
      // exactly one raw reset survives — the one inside closeDetail
      expect(body.match(/state\.detail=null;state\.detailData=null/g)?.length).toBe(1);
    });

    it('never leaves ?booking= set on a surface that cannot show it', async () => {
      const body = await uiBody();
      expect(body).toContain("if(route==='tickets'&&bookingId)url.searchParams.set('booking',bookingId);");
      expect(body).toContain("if(route!=='tickets')closeDetail('silent');");
    });
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

describe('ops UI — manual refund workflow (SH9)', () => {
  it('loads the canonical refund ledger only for staff with payments:act', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain("state.caps.includes('payments:act')");
    expect(body).toContain("adminApi.get('/bookings/'+id+'/refunds')");
    expect(body).toContain('function refundSummary(');
    expect(body).toContain('Refundable remaining');
  });

  it('renders request, confirm, and cancel actions against the ledger endpoints', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('data-act="refundrequest"');
    expect(body).toContain('data-act="refundconfirm"');
    expect(body).toContain('data-act="refundcancel"');
    expect(body).toContain("adminApi.post('/bookings/'+id+'/refunds'");
    expect(body).toContain("'/confirm'");
    expect(body).toContain("'/cancel'");
  });

  it('still offers the manual dashboard route, with evidence, alongside the API one', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('Or refund it by hand in the PayHere dashboard');
    expect(body).toContain('PayHere refund reference');
    expect(body).toContain('gatewayRef');
  });

  it('shows pending, confirmed, and cancelled ledger entries with actors and evidence', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('refund-status-manual_pending');
    expect(body).toContain('refund-status-manual_confirmed');
    expect(body).toContain('refund-status-cancelled');
    expect(body).toContain('requestedBy');
    expect(body).toContain('confirmedBy');
    expect(body).toContain('gatewayRef');
  });

  // The API path (PayHere Refund API, reachable since they whitelisted our egress 2026-08-07).
  it('can fire the Refund API from the sheet, and labels all six statuses', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('data-act="refundexecute"');
    expect(body).toContain("'/refunds/'+refundId+'/execute'");
    // Every status gets its own label. The old ternary ended in :'Cancelled', so a successful
    // api_confirmed refund — and an api_processing one — both read as "Cancelled".
    expect(body).toContain('api_processing:');
    expect(body).toContain('api_confirmed:');
    expect(body).toContain('api_failed:');
    expect(body).not.toContain(
      "r.status==='manual_pending'?'Pending':r.status==='manual_confirmed'?'Confirmed':'Cancelled'",
    );
  });

  it('counts API refunds as money spoken for, exactly as the server does', async () => {
    const body = await (await createApp().request('/ops')).text();
    // Must mirror REFUNDED_STATUSES / RESERVING_STATUSES in db/refundRepo.ts. Counting only the
    // manual statuses made a fully API-refunded booking read as fully refundable.
    expect(body).toContain("const REFUND_SETTLED=['manual_confirmed','api_confirmed'];");
    expect(body).toContain("const REFUND_IN_FLIGHT=['manual_pending','api_processing'];");
  });

  it('refuses to retry an indeterminate refund and says why', async () => {
    const body = await (await createApp().request('/ops')).text();
    // api_processing means the money MAY have moved and the API has no idempotency key.
    expect(body).toContain('Check PayHere before doing anything else');
    expect(body).toContain('refund_outcome_unknown');
  });
});

// Bare-root alias (2026-07-19): ops.ceylonhop.com/ should serve the tool, not only /ops.
// The shell is served at BOTH "/" and "/ops" (same-origin, same cookie); the client builds
// URLs from location.pathname (ops-ui.html), so at the bare root the URL stays at "/".
describe('ops UI — bare-root alias (ops.ceylonhop.com/)', () => {
  it('serves the same shell at "/" as at "/ops"', async () => {
    const app = createApp();
    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    const rootBody = await root.text();
    expect(rootBody).toContain('Ceylon Hop');
    expect(rootBody).toContain('/admin/ops'); // wired to the real API, not mock data
    // Byte-identical to the /ops shell — one tool, two paths.
    const opsBody = await (await app.request('/ops')).text();
    expect(rootBody).toBe(opsBody);
  });

  it('gzip-compresses the "/" shell for clients that accept it', async () => {
    const app = createApp();
    const res = await app.request('/', { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const gz = Buffer.from(await res.arrayBuffer());
    const body = gunzipSync(gz).toString('utf8');
    expect(body).toContain('Ceylon Hop');
    expect(gz.length).toBeLessThan(body.length / 2);
  });

  it('keeps the /ops path working, still gzipped (regression)', async () => {
    const app = createApp();
    const res = await app.request('/ops', { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('does not shadow other routes — /health is still its JSON, not the shell', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ status: 'ok' });
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
    // Two toggles, not three single-select buttons — selecting both IS "both" (owner, 2026-07-17).
    expect(body).toContain("[['private', 'Point-to-point'], ['chauffeur', 'Chauffeur-guide']]");
    expect(body).not.toContain("['both', 'Both']"); // the third button is gone
    expect(body).toContain('function requestedIncludes('); // stored enum still derives to 'both'
    expect(body).toContain("(p2p && chauf) ? 'both'"); // both toggles on -> stored 'both'
    expect(body).toContain('requestedService: null'); // I4: never derived from the priced service
  });

  it("recording 'both' switches the chauffeur upsell on so the second price can't be forgotten (I9)", async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain("if (next === 'both') outputIncludeChauffeurUpsell = true;");
    expect(body).toContain('data-action="toggleChauffeurUpsell"'); // still overridable
  });

  it('sends it on save and restores it on reopen', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('requestedService: state.requestedService');
    expect(body).toContain('tool.requestedService');
  });

  // The control was moved out of the right-hand price panel into the trip basics (an intake fact,
  // beside the vehicle chips). The MISMATCH warning stays with the prices. Guard both, so the
  // relocation can't silently regress.
  it('places the control in the trip basics (beside the vehicle chips), not the price panel', async () => {
    const body = await (await createApp().request('/ops')).text();
    // Its own render fn, called right after renderVehicleChips() in the basics card.
    expect(body).toContain('function renderRequestedService(');
    expect(body).toMatch(/renderVehicleChips\(\),[\s\S]{0,400}renderRequestedService\(\)/);
    // The chips no longer build inside the service chooser — only the mismatch warning does.
    const svc = body.slice(body.indexOf('function renderServiceChooser('));
    const svcBody = svc.slice(0, svc.indexOf('\nfunction '));
    expect(svcBody).not.toContain('data-action="setRequestedService"');
    expect(svcBody).toContain('requestMismatch(state.requestedService, state.service)');
  });
});

// requestMismatch is pure and DOM-free, so we lift it out of the inlined shell script and
// table-test all six (recorded, priced) combinations directly — an e2e per row would be absurd.
describe('requestMismatch (spec 2026-07-17, I8/I10)', () => {
  let f: (r: string | null, p: string) => string | null;
  beforeAll(async () => {
    const body = await (await createApp().request('/ops')).text();
    const start = body.indexOf('function requestMismatch(');
    expect(start).toBeGreaterThan(-1);
    let depth = 0; let i = body.indexOf('{', start);
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) break;
    }
    const src = body.slice(start, i + 1);
    // eslint-disable-next-line no-new-func
    f = new Function(`${src}; return requestMismatch;`)() as typeof f;
  });

  it('is silent when nothing is recorded yet', () => {
    expect(f(null, 'private')).toBeNull();
  });
  it('is silent when the record matches what was priced', () => {
    expect(f('private', 'private')).toBeNull();
    expect(f('chauffeur', 'chauffeur')).toBeNull();
  });
  it("is silent for 'both' on a point-to-point quote — the upsell carries the second price", () => {
    expect(f('both', 'private')).toBeNull();
  });
  it('flags a recorded point-to-point priced as chauffeur', () => {
    expect(f('private', 'chauffeur')).toMatch(/Point-to-point/);
  });
  it('flags a recorded chauffeur priced as point-to-point', () => {
    expect(f('chauffeur', 'private')).toMatch(/Chauffeur-guide/);
  });
  it("flags 'both' on a chauffeur quote — the upsell is one-directional, so it can't show both (I10)", () => {
    expect(f('both', 'chauffeur')).toMatch(/point-to-point/i);
  });

  it('renders the mismatch line from live state', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('requestMismatch(state.requestedService, state.service)');
    expect(body).toContain('ch-req-mismatch');
  });

  // Owner report 2026-07-26: the old 'both' line explained an internal constraint (the upsell is
  // one-directional) instead of naming the fix, and read as gibberish next to a chooser that was
  // visibly showing both prices. It must lead with the action and never mention "can't carry".
  it("the 'both' note names the fix rather than the internal constraint", () => {
    const msg = f('both', 'chauffeur') as string;
    expect(msg).toMatch(/switch/i);
    expect(msg).toMatch(/message to the customer/i);
    expect(msg).not.toMatch(/can't carry/i);
  });

  it("offers a one-click switch on the 'both' mismatch, and only there", async () => {
    const body = await (await createApp().request('/ops')).text();
    // The button is gated on exactly the 'both' + chauffeur pair — every other mismatch is a
    // judgement call, so it must not sprout a remedy button.
    expect(body).toContain("state.requestedService === 'both' && state.service === 'chauffeur'");
    expect(body).toMatch(/ch-mismatch-fix[\s\S]{0,200}data-action="setService" data-service="private"/);
  });
});

// itineraryGapDetail is pure and DOM-free (it takes the legs array), so — like requestMismatch —
// we lift it out of the inlined shell script and table-test the continuity cases directly.
// It warns when a leg doesn't start where the previous one ended (an agent's missed/mis-typed
// leg), and stays silent when the route connects, when a segment is half-built, or when the
// place names differ only by Google's ", Sri Lanka" suffix / "(CMB)" tag.
describe('itineraryGapDetail (ops builder — non-sequential legs)', () => {
  type Leg = { category?: string; pickupLocation?: string; dropoffLocation?: string };
  let gap: (legs: Leg[]) => string | null;
  beforeAll(async () => {
    const body = await (await createApp().request('/ops')).text();
    const start = body.indexOf('function itineraryGapDetail(');
    expect(start).toBeGreaterThan(-1);
    let depth = 0; let i = body.indexOf('{', start);
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) break;
    }
    const src = body.slice(start, i + 1);
    gap = new Function(`${src}; return itineraryGapDetail;`)() as typeof gap;
  });
  const t = (pickupLocation: string, dropoffLocation: string, category = 'transfer'): Leg => ({ category, pickupLocation, dropoffLocation });
  const stay = (loc: string): Leg => ({ category: 'stay_day', pickupLocation: loc, dropoffLocation: loc });

  it('is silent for a single leg (nothing to connect to)', () => {
    expect(gap([t('Colombo', 'Kandy')])).toBeNull();
  });
  it('is silent when every leg starts where the previous ended', () => {
    expect(gap([t('Colombo', 'Kandy'), t('Kandy', 'Ella'), t('Ella', 'Galle')])).toBeNull();
  });
  it('flags a leg that starts somewhere the previous leg did not end', () => {
    // The reported case: A→B then C→C leaves the B→C stretch unaccounted for.
    const d = gap([t('A', 'B'), t('C', 'C')]);
    expect(d).toMatch(/Leg 2 starts at C, but leg 1 ends at B/);
  });
  it('names the first gap when there are several legs', () => {
    const d = gap([t('Colombo', 'Kandy'), t('Kandy', 'Ella'), t('Colombo', 'Trincomalee')]);
    expect(d).toMatch(/Leg 3 starts at Colombo, but leg 2 ends at Ella/);
  });
  it('does not gap on Google name variants (", Sri Lanka" suffix / "(CMB)" tag)', () => {
    expect(gap([t('Colombo', 'Kandy'), t('Kandy, Sri Lanka', 'Ella')])).toBeNull();
    expect(gap([t('Colombo City', 'Colombo Airport (CMB)'), t('Colombo Airport', 'Kandy')])).toBeNull();
  });
  it('stays quiet while a leg is still half-built (no phantom gap mid-entry)', () => {
    expect(gap([t('Colombo', 'Kandy'), t('', '')])).toBeNull();
    expect(gap([t('Colombo', 'Kandy'), t('', 'Ella')])).toBeNull();
  });
  it('treats a stay day as staying put — connected before and after', () => {
    expect(gap([t('Colombo', 'Kandy'), stay('Kandy'), t('Kandy', 'Ella')])).toBeNull();
    expect(gap([t('Colombo', 'Kandy'), stay('Ella')])).toMatch(/Leg 2 starts at Ella, but leg 1 ends at Kandy/);
  });
});

// Quote intent (spec 2026-07-17): the client mirrors the server gate — Submit/Approve are
// disabled until the customer request is recorded, and a bypassed 400 gets friendly copy.
describe('ops UI — submit gated on recorded request', () => {
  it('disables submit/approve until the request is recorded, with a hint', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('!state.requestedService');
    expect(body).toContain('Record what the customer asked for first');
  });
  it('maps the server 400 to the same friendly copy for a bypassed client', async () => {
    const body = await (await createApp().request('/ops')).text();
    expect(body).toContain('requested_service_required');
  });
});

// Design elevation (2026-07-17): live price hero, keyboard-first, autosave, suggestion,
// motion, dark mode. Source-level assertions, same style as the quote-intent block above;
// behaviour is exercised in the browser + web-tests e2e.
describe('ops UI — design elevation', () => {
  let body: string;
  beforeAll(async () => { body = await (await createApp().request('/ops')).text(); });

  it('D1: the price never disappears — em-dash hero + one quiet needs line', () => {
    expect(body).toContain('function priceNeeds(');
    expect(body).toContain('ch-total-usd pending');
    expect(body).toContain("'To price: ' + needs.join(' &middot; ')");
  });

  it('D1: the price panel names its role — "Pricing as" over the service boxes', () => {
    expect(body).toContain('Pricing as');
  });

  it('D2: command palette exists with shell actions and module-contextual merge', () => {
    expect(body).toContain('id="kbar"');
    expect(body).toContain('function kbarActions(');
    expect(body).toContain('window.opsQuoteKbar');
  });

  it('D2: Enter adds a leg (guarded on the place menu) and ⌘S saves', () => {
    expect(body).toContain("e.key === 'Enter'");
    expect(body).toContain("addLeg('transfer');");
    expect(body).toContain("(e.metaKey || e.ctrlKey) && (e.key === 's'");
  });

  it('D3: the smallest fitting vehicle is suggested, never auto-selected', () => {
    expect(body).toContain("id === sug ? ' suggest'");
    expect(body).toContain('fits this group');
    expect(body).not.toContain('vehicleType = sug'); // suggestion must not silently pick
  });

  // Spec 2026-07-29: the row now exists from "+ New quote", so savedId is no longer part of the
  // gate — a shell's first real content must be able to autosave. vehicleType still gates it,
  // because POST /save prices server-side and cannot persist an unpriceable payload.
  it('D4: autosave is debounced, gated on priceability + editable status, with a saved chip', () => {
    expect(body).toContain('function fireAutosave(');
    expect(body).toContain('setTimeout(fireAutosave, 2500)');
    expect(body).toContain('if (!isEditableNow() || !state.vehicleType) return;');
    expect(body).not.toContain('if (!state.savedId || !isEditableNow()');
    expect(body).toContain('ch-savestate');
  });

  it('D6: dark theme tokens + persisted toggle + pre-paint init', () => {
    expect(body).toContain(':root[data-theme="dark"]');
    expect(body).toContain("localStorage.setItem('ch_ops_theme'");
    expect(body).toContain('prefers-color-scheme: dark');
    expect(body).toContain('id="railTheme"');
  });

  it('D5: arrival motion is one-shot and respects reduced motion', () => {
    expect(body).toContain('mount-rise');
    expect(body).toContain('just-unlocked');
    expect(body).toContain('prefers-reduced-motion');
  });
});

// Review lock (owner, 2026-07-17): submission freezes content; reopen-to-draft is the one
// explicit door back in. Server enforces via /save 409 — these assert the UI tells the truth.
describe('ops UI — review lock', () => {
  let body: string;
  beforeAll(async () => { body = await (await createApp().request('/ops')).text(); });

  it('pending_review is no longer client-editable (gates autosave, ⌘S, palette, vehicle keys)', () => {
    expect(body).toContain("return state.status === 'draft' || state.status === 'changes_requested';");
    expect(body).not.toContain("state.status === 'draft' || state.status === 'pending_review' || state.status === 'changes_requested'");
  });

  it('the editor renders inert while locked, with the map toggle exempt', () => {
    expect(body).toContain('function applyContentLock(');
    expect(body).toContain("classList.toggle('ch-locked', locked)");
    expect(body).toContain('viewing the route is not editing');
  });

  it('every locked row in the action bar offers the reopen door, and review loses Save', () => {
    const bar = body.slice(body.indexOf('function renderActionBar('), body.indexOf('function renderReviewBanner('));
    const reviewRows = bar.split('\n').filter(l => l.includes("'pending_review'"));
    expect(reviewRows.length).toBeGreaterThanOrEqual(2); // approver + submitter rows
    reviewRows.forEach(row => expect(row).toContain("reopenToDraft"));
    reviewRows.forEach(row => expect(row).not.toContain('SAVE'));
  });

  it('the banner names the lock', () => {
    expect(body).toContain('In review — locked');
    expect(body).toContain('Submitted — locked');
  });
});

// Unpriced shells (spec 2026-07-29): "+ New quote" claims a real $0 row up front so the ticket is
// assignable before anything is priced. The chip must say what is actually pending — a PRICE, not
// persistence — and that marker must clear the moment a real save prices the row. Source-level
// assertions anchored to the OWNING FUNCTION's body, so a copy change or a dropped assignment
// fails here rather than being satisfied by the string existing anywhere in a 7700-line page.
describe('ops UI — unpriced shell lifecycle', () => {
  let body: string;
  beforeAll(async () => { body = await (await createApp().request('/ops')).text(); });

  /** The source of `function <name>(`, brace-matched to its closing `}`. */
  function fnBody(name: string): string {
    const start = body.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    let depth = 0; let i = body.indexOf('{', start);
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) break;
    }
    return body.slice(start, i + 1);
  }

  it('the save chip never says "Not priced yet" over unsaved typed content', () => {
    const chip = fnBody('renderSaveState');
    // "Not priced yet" belongs to ONE branch only: the clean shell, where there is no typed
    // content at risk. While _dirty, something typed has not reached the server — autosave is
    // debounced, and before a vehicle type fireAutosave() does not run at all, so the customer
    // name, contact, legs and internal notes are held in memory only. Saying "Not priced yet"
    // there told the operator their typing was safe when it was not.
    expect(chip.match(/txt = 'Not priced yet'/g)).toHaveLength(1); // assignments, not prose
    expect(chip).not.toContain("state.unpriced ? 'Not priced yet'");
    expect(chip).toContain("txt = 'Not priced yet';");
    // The dirty branch talks about PERSISTENCE. "Edits pending" is reserved for a row that has
    // already saved successfully at least once — which is exactly `savedId && !unpriced`, since
    // the shell marker clears only on a successful save. Everything else is "Unsaved".
    expect(chip).toContain("txt = (state.savedId && !state.unpriced) ? 'Edits pending' : 'Unsaved';");
    // Branch ORDER, not just text: error must be checked before dirty. A failed save leaves
    // _dirty true, so if the dirty branch came first it would win and the error chip would be
    // unreachable — exactly the bug this test suite exists to pin.
    expect(chip.indexOf("_autoState === 'error'")).toBeLessThan(chip.indexOf('else if (_dirty)'));
    // …and the clean-shell branch stays BELOW dirty, or it would swallow the dirty chip again.
    expect(chip.indexOf('else if (_dirty)')).toBeLessThan(chip.indexOf("txt = 'Not priced yet';"));
  });

  it('a real autosave failure surfaces on a shell — the shell marker must not suppress it', () => {
    const chip = fnBody('renderSaveState');
    // state.unpriced clears only on a SUCCESSFUL save, so it is still true while a shell's
    // autosave is failing. Gating the error branch on it swallowed every failed save of a
    // not-yet-priced row: autosave is silent (no toast), so a fully-filled quote showing its
    // price could fail to persist indefinitely and the chip would read a benign "Not priced yet",
    // never advertising the Save-button escape hatch.
    expect(chip).not.toContain("_autoState === 'error' && !state.unpriced");
    // The distinction is whether autosave can run at all — fireAutosave() returns early without
    // a vehicle type, so an unpriceable shell never reaches _autoState 'error' in the first
    // place. That keeps the original intent without suppressing a genuine failure.
    expect(chip).toContain('var autosaveArmed = !!state.vehicleType;');
    expect(chip).toContain("else if (_autoState === 'error' && autosaveArmed)");
    expect(chip).toContain("txt = 'Autosave failed &mdash; use Save';");
    // The gate is only meaningful if it matches fireAutosave's own early return.
    expect(fnBody('fireAutosave')).toContain('if (!isEditableNow() || !state.vehicleType) return;');
  });

  it('claiming the row marks it unpriced, and a successful save clears the marker', () => {
    expect(fnBody('claimDraftRow')).toContain('state.unpriced = true;');
    const save = fnBody('saveQuote');
    // Inside the `res && res.id` success block — not in the failure paths below it.
    const ok = save.slice(save.indexOf('if (res && res.id) {'));
    expect(ok).toContain('state.unpriced = false;');
    expect(ok.indexOf('state.unpriced = false;')).toBeLessThan(ok.indexOf('return true;'));
  });

  it('reopening a shell binds the builder to that row and keeps its notes', () => {
    const reopen = fnBody('reopenQuote');
    const shell = reopen.slice(reopen.indexOf("q.request.shell === true"));
    expect(shell).toContain('state.unpriced = true;');
    expect(shell).toContain('state.internalNotes = q.internalNotes');
  });

  it('the claimed row is bound into the URL by history replace, never push', () => {
    expect(fnBody('claimDraftRow')).toContain('window.opsBindQuoteUrl(res.id)');
    expect(body).toContain("setShellRoute('quote',{ quoteId:id, replace:true })");
  });

  it('the shell price blocker cannot fire while a price is on screen', () => {
    const blockers = fnBody('submitBlockers');
    // `state.unpriced` only clears on a save round-trip and autosave is debounced 2.5s, so a bare
    // `if (state.unpriced)` told an operator the quote "has not been priced yet" with the real
    // total right there on screen — and submitForReview() checks the blockers BEFORE transition()
    // runs the save that would have cleared it. The blocker must be gated on the absence of a
    // price, never on the shell marker alone.
    expect(blockers).toContain('if (state.unpriced && !lastEstimate) add(');
    expect(blockers).not.toMatch(/if \(state\.unpriced\) add\(/);
    // The two price branches stay mutually exclusive (else-if), so the panel can never name a
    // price twice, and the "could not be costed" line still comes last — it only speaks up when
    // nothing else already explains the missing price.
    expect(blockers.indexOf('if (state.unpriced && !lastEstimate)'))
      .toBeLessThan(blockers.indexOf('else if (!out.length && !lastEstimate'));
    // …and it waits for pricing to SETTLE. While a re-price is in flight `!lastEstimate` cannot
    // tell "not costed yet" from "could not be costed", which is what silently swallowed the
    // first press of Approve after a reopen (docs/known-bugs.md, 2026-07-30).
    expect(blockers).toContain('!lastEstimate && !_estimatePending');
  });

  it('a save superseded while in flight is dropped and reported as failure', () => {
    const save = fnBody('saveQuote');
    expect(save).toContain('var seq = _openSeq;');
    expect(save).toMatch(/if \(seq !== _openSeq\) \{[\s\S]{0,300}return false;/);
    // The capture must happen BEFORE the await — captured after it (or dropped below it) can
    // never differ from the live _openSeq by the time it's compared, making the guard permanently
    // inert while every assertion here still passes.
    expect(save.indexOf('var seq = _openSeq;')).toBeLessThan(save.indexOf('await apiSave('));
    // The guard must sit between the await and the state writes.
    expect(save.indexOf('if (seq !== _openSeq)')).toBeGreaterThan(save.indexOf('await apiSave('));
    expect(save.indexOf('if (seq !== _openSeq)')).toBeLessThan(save.indexOf('state.savedId = res.id;'));
  });

  it('an assign superseded while in flight is dropped, not painted onto the quote now open', () => {
    const assign = fnBody('assignQuote');
    // assignQuote was the one async state writer without the guard, and the shell row made it far
    // more reachable: the picker is live from the first click. Assign A, click B, the PATCH
    // resolves — without this, B shows A's assignee and toasts "Assigned to …" while B is
    // untouched server-side.
    expect(assign).toContain('var seq = _openSeq;');
    expect(assign).toContain('if (seq !== _openSeq)');
    // Captured BEFORE the await, or it can never differ from the live _openSeq when compared —
    // permanently inert while a mere toContain assertion still passes.
    expect(assign.indexOf('var seq = _openSeq;')).toBeLessThan(assign.indexOf('await apiPatch('));
    // …and compared AFTER it, ahead of BOTH branches: the failure toast + re-render is as wrong
    // on the newly-opened quote as the success write is.
    expect(assign.indexOf('if (seq !== _openSeq)')).toBeGreaterThan(assign.indexOf('await apiPatch('));
    expect(assign.indexOf('if (seq !== _openSeq)')).toBeLessThan(assign.indexOf('if (!res || res.error)'));
    expect(assign.indexOf('if (seq !== _openSeq)')).toBeLessThan(assign.indexOf('state.assignedTo = res.assignedTo'));
  });

  it('the itinerary basics gate is not unlocked by the shell row merely existing', () => {
    // claimDraftRow() sets savedId within ~200ms of "+ New quote", so a bare `!!st.savedId` made
    // showItinerary true on every new quote: the ch-itin-locked guidance panel only flashed, the
    // just-unlocked reveal never played, and the section appeared under the operator's cursor
    // mid-typing. "Already saved with real content" is now savedId AND the shell marker cleared.
    const gate = body.split('\n').find(l => l.includes('var hasBuiltItinerary =')) as string;
    expect(gate).toBeTruthy();
    expect(gate).toContain('(!!st.savedId && !st.unpriced)');
    expect(gate).not.toMatch(/=\s*!!st\.savedId \|\|/);
    // The other half — real typed leg content — still unlocks it, so a built itinerary is never
    // hidden, and basicsDone remains the ordinary way in.
    expect(gate).toContain("(s || '').trim() !== ''");
    expect(body).toContain('var showItinerary = basicsDone || hasBuiltItinerary;');
    // The panel the gate exists to show is still wired to it.
    expect(body).toContain('ch-itin-locked');
    expect(body).toContain('Complete the trip basics to start');
    expect(body).toContain('esc(basicsMissingText())');
  });
});

// ── Confirm location (spec 2026-08-02) ───────────────────────────────────────
describe('the ops builder can identify a place the server would not guess', () => {
  const uiBody = async () => await (await createApp().request('/ops')).text();

  it('offers Confirm location on a segment whose endpoint is unresolved', async () => {
    const body = await uiBody();
    expect(body).toContain('data-action="confirmPlace"');
    expect(body).toContain('function unresolvedStopFor(');
  });

  it('records what the server reported as unidentified rather than inferring it', async () => {
    const body = await uiBody();
    expect(body).toContain('function noteUnresolved(');
    expect(body).toContain('body.unresolved');
  });

  it('mirrors canonPlace so a name confirmed one way clears the warning shown another way', async () => {
    const body = await uiBody();
    expect(body).toContain('function canonPlaceKey(');
    expect(body).toMatch(/sri lanka/);
  });

  it('re-prices every leg touching a place the moment it is confirmed', async () => {
    const body = await uiBody();
    expect(body).toContain('scheduleAutoDistance(l.id)');
    expect(body).toContain('delete unresolvedPlaces[canonPlaceKey(name)]');
  });

  it('distinguishes candidates by area and distance, since Google labels both Yalas the same', async () => {
    const body = await uiBody();
    expect(body).toContain('km from the previous stop');
    expect(body).toContain('ch-cand');
  });
});

// ── Cancel & refund window (owner rule 2026-08-02) ───────────────────────────
describe('the drawer mirrors the 24-hour reversal rule', () => {
  const uiBody = async () => await (await createApp().request('/ops')).text();

  it('computes the trip start in Asia/Colombo, matching the server', async () => {
    const body = await uiBody();
    expect(body).toContain('function tripStartMs(');
    expect(body).toContain(":00+05:30`"); // NOT Z — parsing as UTC was 5.5 hours out
    expect(body).not.toContain("T${hhmm}:00Z");
  });

  it('fails closed when the trip start is unknown', async () => {
    const body = await uiBody();
    expect(body).toContain('function opsWindowOpen(');
    expect(body).toContain('if(at === null) return false;');
  });

  it('time-limits ops but never a founder', async () => {
    const body = await uiBody();
    expect(body).toContain('function mayReverseNow(');
    expect(body).toContain("state.caps.includes('payments:reverse')) return true;");
    // The rule itself, now inside reverseGate() where the split refund and cancel blocks share
    // it (2026-08-07). It reads the same as the line it replaced: only an ops agent is
    // time-limited, and only when BOTH the fresh-intake grace and the trip window have closed.
    expect(body).toContain('blocked: opsAgent && !opsGraceOpen(d) && !opsWindowOpen(t),');
  });

  // The other half of the contract these assertions rest on. Every test above proves the client
  // ASKS for a capability; none proved the server ever ANSWERS with it. That gap is not
  // theoretical — /whoami built its caps list by hand and omitted 'payments:reverse', so the
  // guard asserted two tests up was permanently false and refund confirm/cancel were dead
  // buttons for the founder, the only role that holds it. Every suite stayed green throughout.
  //
  // So: pull every capability the shipped HTML gates on straight out of the served body, and
  // require the server to be able to emit each one. Reading the real artifact rather than a
  // hand-kept list is the point — a new caps.includes('…') in the client is covered the moment
  // it ships, with no second place to remember to update.
  it('never gates on a capability /whoami cannot emit', async () => {
    const body = await uiBody();
    const gated = [...body.matchAll(/caps\.includes\('([^']+)'\)/g)].map((m) => m[1]);
    expect(gated.length).toBeGreaterThan(0); // the regex still matches the shipped source
    expect([...new Set(gated)].sort()).toEqual(
      [...new Set(gated)].filter((cap) => (ALL_OPS_ACTIONS as readonly string[]).includes(cap)).sort(),
    );
  });

  // Bookings frequently arrive inside 24h of travel, so ops must be able to undo fresh intake.
  it('gives ops a grace window on a booking they just took', async () => {
    const body = await uiBody();
    expect(body).toContain('function opsGraceOpen(');
    expect(body).toContain("d.booking.createdAt");
    expect(body).toContain('if(!Number.isFinite(created)) return false;'); // unknown age fails closed
  });

  // Two fields, not one (2026-08-07). Cancel and refund used to share #reversereason because they
  // shared a block. Now that they are separate blocks, one shared input would let a reason typed
  // for a cancellation be submitted with a refund — and both are written to permanent audit
  // records. The ids must stay distinct, and each handler must read its own.
  it('requires a typed reason for both cancelling and refunding, from separate fields', async () => {
    const body = await uiBody();
    expect(body).toContain('id="cancelreason"');
    expect(body).toContain('id="refundreason"');
    expect(body).not.toContain('id="reversereason"'); // the shared field is gone
    expect(body).toContain("$('#cancelreason')");
    expect(body).toContain("$('#refundreason')");
    expect(body).toContain('it is saved against the booking');
    expect(body).toContain('it is saved against the refund');
  });

  // The 2026-08-07 consolidation. Requesting a refund HIDES the request button (a full-amount
  // pending row drives `remaining` to 0), so if the controls that complete it live somewhere
  // else, pressing Refund looks like a button that broke. Request and completion now share one
  // block, and the block that starts a cancellation offers no refund control at all.
  it('puts the refund request inside the Refunds block, not the cancel block', async () => {
    const body = await uiBody();
    // the request form is built by the Refunds block, via its `request` slot
    expect(body).toContain('const request=refundRequestFor(t,d);');
    expect(body).toContain('function refundRequestFor(');
    // and the cancel block is now cancel-only, retitled to match
    expect(body).toContain('<h4>Cancel booking</h4>');
    expect(body).not.toContain('<h4>Cancel &amp; refund</h4>');
  });

  // The label must match what the press actually does. It once said "Refund $X in full" while
  // moving no money, and the owner read it as completed three times in one evening. The button
  // now DOES refund (2026-08-08), so the rule inverts but does not relax: an operator who can
  // fire the API is promised a refund and gets one; an operator who cannot is promised a request
  // and told plainly that no money moved.
  it('never tells the operator a requested refund has been paid', async () => {
    const body = await uiBody();
    // One template, both wordings, chosen by the capability that decides which actually happens.
    expect(body).toContain("${mayFire?'Refund':'Request refund'}");
    expect(body).toContain("const mayFire = !!(state.caps && state.caps.includes('payments:reverse'))");
    expect(body).not.toContain('in full</button>');          // the old over-promising label
    expect(body).not.toContain('complete it in PayHere');    // predated the Refund API button
    // The request-only path still says so, in the confirm and in the toast.
    expect(body).toContain('no money has moved yet');
    expect(body).toContain('files the request for someone who can');
    // …and the old wording, which claimed nothing had moved when now it has, is gone.
    expect(body).not.toContain('This records the request — no money moves yet');
    // A one-press refund must warn that it is final.
    expect(body).toContain('There is no undo.');
  });

  // Both blocks answer the same question about who may reverse and whether the ops window has
  // closed. They were one function until the split; a divergence would offer a cancel where a
  // refund is refused, or vice versa.
  it('gates the split refund and cancel blocks through one shared reversal test', async () => {
    const body = await uiBody();
    expect(body).toContain('function reverseGate(');
    // both call sites read the same helper rather than re-deriving the rule
    expect(body.match(/reverseGate\(t, ?d\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  // A refund that settles flips the BOOKING to refunded. reloadRefundDetail repaints only the
  // sheet's detail payload, so without refreshRow the header chip and queue row keep reading
  // "Paid" after the money went back — which reads as a refund that failed (owner, 2026-08-07).
  it('refreshes the queue row on the refund actions that change booking status', async () => {
    const body = await uiBody();
    // Bounded to ONE case block: split on the label, then cut at the next one. Without the second
    // cut the slice runs to the end of the file, so an assertion about refundconfirm would be
    // satisfied by refundexecute's call — a test that cannot fail. Caught by deleting the call
    // and watching it still pass.
    const handler = (name: string) => (body.split(`case '${name}':`)[1] ?? '').split("case '")[0];

    expect(handler('refundconfirm')).toContain('await refreshRow(id)');
    // The API path moved into fireRefund() when the request button gained one-press refunding
    // (2026-08-08) — so the repaint is asserted where it now lives, and BOTH ways in are checked
    // to route through it. That is stronger than before: one implementation, not two to drift.
    const fire = (body.split('async function fireRefund(')[1] ?? '').split('\nasync function ')[0];
    expect(fire).toContain('await refreshRow(bookingId)');
    expect(handler('refundexecute')).toContain('fireRefund(id,refundId)');
    expect(handler('refundrequest')).toContain('fireRefund(id,refund&&refund.id)');
    // Guard the guard: each slice must be a plausible single handler, not the rest of the file.
    expect(handler('refundconfirm').length).toBeLessThan(3000);
    expect(handler('refundexecute').length).toBeLessThan(3000);
    expect(fire.length).toBeLessThan(3000);
  });

  it('translates the server refusal codes instead of saying "could not cancel"', async () => {
    const body = await uiBody();
    expect(body).toContain("err.message==='within_24h_founder_only'");
    expect(body).toContain("err.message==='trip_start_unknown'");
  });
});

describe('founder manual discount control', () => {
  const shell = async () => (await createApp().request('/ops')).text();

  it('gates the control on the capability, not on a hardcoded role', async () => {
    const body = await shell();
    expect(body).toContain("viewerCan('discount:apply_manual')");
    // The same mistake the quote:approve gate was fixed for — never re-introduce a role string.
    expect(body).not.toContain("state.role==='founder' && state.discount");
  });

  it('renders the control under the total, and only while the quote is editable', async () => {
    const body = await shell();
    expect(body).toContain('discountControlHtml(est)');
    expect(body).toContain('function discountEditable()');
    // draft / changes_requested only — matching the save route, which refuses any other status.
    expect(body).toContain("st === 'draft' || st === 'changes_requested'");
    expect(body).toContain('Reopen to edit to change the discount.');
  });

  it('offers both an amount and a percent, and demands a reason', async () => {
    const body = await shell();
    expect(body).toContain('data-discount-method');
    expect(body).toContain('>$ off<');
    expect(body).toContain('>% off<');
    expect(body).toContain('Reason (required)');
    expect(body).toContain("toast('A reason is required')");
  });

  it('converts dollars and percents to the WIRE units in exactly one place', async () => {
    const body = await shell();
    // A $10.00 discount must never be sent as 10 cents. One converter each way.
    expect(body).toContain('function discountWireValue(method, typed)');
    expect(body).toContain('function discountInputValue(d)');
  });

  it('sends null — not undefined — when the founder removes one', async () => {
    const body = await shell();
    // JSON.stringify DROPS undefined, and the server reads absent as "preserve": the opposite of
    // remove. _discountTouched is what separates "changed it" from "never had one".
    expect(body).toContain('_discountTouched');
    expect(body).toContain('function removeDiscount()');
  });

  it('never computes an applied amount client-side — the server owns both limits', async () => {
    const body = await shell();
    // The pane renders what it is given. No 30% and no floor arithmetic in the browser.
    expect(body).not.toContain('MAX_DISCOUNT_PCT');
    expect(body).not.toContain('* 0.3');
    expect(body).toContain('data-testid="discount-applied"');
    expect(body).toContain('data-testid="discount-cap"');
  });

  it('uses the delegated dispatcher, so it survives a money-pane re-render', async () => {
    const body = await shell();
    expect(body).toContain("data-action=\"applyDiscount\"");
    expect(body).toContain("action === 'applyDiscount'");
    expect(body).toContain("action === 'removeDiscount'");
  });
});
