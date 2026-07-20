import { describe, it, expect, beforeAll } from 'vitest';
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

  it('D4: autosave is debounced, gated on savedId + editable status, with a saved chip', () => {
    expect(body).toContain('function fireAutosave(');
    expect(body).toContain('setTimeout(fireAutosave, 2500)');
    expect(body).toContain('if (!state.savedId || !isEditableNow() || !state.vehicleType) return;');
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
