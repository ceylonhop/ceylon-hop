import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { rideCopy } from './shareCard';
import { storyModel, storySvg } from './shareCardImage';

// GET /r/:code — the share-link destination a chat app fetches to build its preview.
// Crawlers never run JavaScript, so everything they need is in this HTML: per-ride og
// tags plus an image URL. Humans get bounced on to the board page.
//
// Deliberately NOT mounted on /board/:code, which already answers JSON to board.js.

const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'airport-cultural', fromPlace: 'Colombo Airport (CMB)', toPlace: 'Dambulla',
  date: '2026-08-15', slot: 'morning', minSeats: 4, capacity: 6, seatPrice: 1900,
  note: null, cutoffAt: new Date('2026-08-14T15:30:00Z'), createdBy: 'creator', ...over,
});

async function seeded(seats: number, over: Partial<CreateListArgs> = {}) {
  const rideLists = new InMemoryRideListRepo();
  const l = await rideLists.createList(listArgs(over));
  const names = ['Anna', 'Yuki', 'Ben', 'Mat', 'Tom', 'Ela'];
  for (let i = 0; i < seats; i++) {
    await rideLists.addMember(l.id, {
      sub: `sub-${i}`, firstName: names[i], country: 'PL',
      email: `${names[i]}@secret.com`, seats: 1,
    });
  }
  return { app: createApp({ rideLists, bookingBaseUrl: 'https://prod.ceylonhop.com' }), code: l.code };
}

const meta = (html: string, prop: string): string | null => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`));
  return m ? m[1] : null;
};

describe('GET /r/:code — share unfurl', () => {
  it('serves HTML with per-ride open-graph tags', async () => {
    const { app, code } = await seeded(5);
    const res = await app.request(`/r/${code}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);

    const html = await res.text();
    expect(meta(html, 'og:title')).toContain('Colombo Airport (CMB)');
    expect(meta(html, 'og:title')).toContain('Dambulla');
    expect(meta(html, 'og:title')).toContain('1 seat left');
    expect(meta(html, 'og:description')).toContain('$19');
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(meta(html, 'og:image')).toMatch(/^https?:\/\/.+\/card\.png\?s=5$/);
  });

  it('states the deadline as a fixed date, never a countdown', async () => {
    const { app, code } = await seeded(5);
    const html = await (await app.request(`/r/${code}`)).text();

    // Chat apps cache a preview for days — "closes in 6h" would still say 6h tomorrow.
    expect(meta(html, 'og:description')).toMatch(/Closes .*Aug/);
    expect(meta(html, 'og:description')).not.toMatch(/closes in|in \d+h/i);
  });

  it('leads with the threshold while a van is still short of it', async () => {
    const { app, code } = await seeded(3); // minSeats 4 — one more locks it in
    const html = await (await app.request(`/r/${code}`)).text();
    expect(meta(html, 'og:title')).toContain('1 more');
  });

  it('says the van is locked once it is full', async () => {
    const { app, code } = await seeded(6);
    const html = await (await app.request(`/r/${code}`)).text();
    expect(meta(html, 'og:title')).toMatch(/locked in/i);
    expect(meta(html, 'og:title')).not.toContain('seat left');
  });

  it('sends a human on to the board page for that ride', async () => {
    const { app, code } = await seeded(5);
    const html = await (await app.request(`/r/${code}`)).text();
    expect(html).toContain(`https://prod.ceylonhop.com/board.html#/${code}`);
  });

  it('bounces humans by script only — no meta refresh for a crawler to follow', async () => {
    // Facebook treats <meta http-equiv="refresh"> as a redirect hop and builds the preview
    // from where it lands: board.html#/CODE, whose fragment it drops, so the post unfurled
    // as the generic board instead of the ride. Crawlers don't run JS; people do.
    const { app, code } = await seeded(5);
    const html = await (await app.request(`/r/${code}`)).text();
    expect(html).not.toMatch(/http-equiv="refresh"/i);
    expect(html).toContain(`location.replace("https://prod.ceylonhop.com/board.html#/${code}")`);

    const stale = await (await app.request('/r/ZZ-9999')).text();
    expect(stale).not.toMatch(/http-equiv="refresh"/i);
  });

  it('never leaks an email or a subject', async () => {
    const { app, code } = await seeded(5);
    const html = await (await app.request(`/r/${code}`)).text();
    expect(html).not.toContain('secret.com');
    expect(html).not.toContain('sub-0');
  });

  it('answers a stale link with a 404 page that still unfurls', async () => {
    const { app } = await seeded(2);
    const res = await app.request('/r/ZZ-9999');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(meta(html, 'og:title')).toBeTruthy();
    expect(html).toContain('https://prod.ceylonhop.com/board.html');
  });

  it('escapes ride text so a place name cannot break out of a meta tag', async () => {
    const { app, code } = await seeded(2, { toPlace: 'Ella "the gap" <script>' });
    const html = await (await app.request(`/r/${code}`)).text();
    // the page carries its own redirect <script>; what must never survive is the ride's
    // own text being read as markup
    expect(html).not.toContain('the gap" <script>');
    expect(html).toContain('&lt;script&gt;');
    expect(meta(html, 'og:title')).toContain('&quot;the gap&quot;');
  });
});

describe('GET /r/:code/card.png — the share image', () => {
  it('renders a real PNG', async () => {
    const { app, code } = await seeded(5);
    const res = await app.request(`/r/${code}/card.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(1, 4)).map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
    // a blank canvas rasterises tiny; a card with text and avatars does not
    expect(bytes.length).toBeGreaterThan(20_000);
  });

  it('is the og:image the unfurl page points at, cache-busted on the seat count', async () => {
    const { app, code } = await seeded(5);
    const html = await (await app.request(`/r/${code}`)).text();
    const img = meta(html, 'og:image')!;
    expect(img).toContain(`/r/${code}/card.png?s=5`);

    const res = await app.request(new URL(img).pathname);
    expect(res.status).toBe(200);
  });

  it('404s for a code that does not exist', async () => {
    const { app } = await seeded(2);
    expect((await app.request('/r/ZZ-9999/card.png')).status).toBe(404);
  });
});

// The share host (ride.ceylonhop.com) is a second custom domain on this same service, so
// links can be as short as possible: https://ride.ceylonhop.com/EA-7797. Serving codes at
// the root means the route must never swallow a real API path, hence the code shape guard.
describe('ride-domain share links at the root', () => {
  const shareApp = async (seats: number) => {
    const rideLists = new InMemoryRideListRepo();
    const l = await rideLists.createList(listArgs());
    for (let i = 0; i < seats; i++) {
      await rideLists.addMember(l.id, {
        sub: `sub-${i}`, firstName: 'Anna', country: 'PL', email: `${i}@secret.com`, seats: 1,
      });
    }
    return {
      app: createApp({
        rideLists,
        bookingBaseUrl: 'https://prod.ceylonhop.com',
        shareBaseUrl: 'https://ride.ceylonhop.com',
      }),
      code: l.code,
    };
  };

  it('serves a bare code at the root', async () => {
    const { app, code } = await shareApp(5);
    const res = await app.request(`/${code}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(meta(html, 'og:title')).toContain('1 seat left');
  });

  it('serves the card image at the root too', async () => {
    const { app, code } = await shareApp(5);
    const res = await app.request(`/${code}/card.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('builds its absolute URLs from the share host, not the request host', async () => {
    const { app, code } = await shareApp(5);
    const html = await (await app.request(`/${code}`)).text();
    expect(meta(html, 'og:url')).toBe(`https://ride.ceylonhop.com/${code}`);
    expect(meta(html, 'og:image')).toBe(`https://ride.ceylonhop.com/${code}/card.png?s=5`);
  });

  it('does not swallow real API paths at the root', async () => {
    const { app } = await shareApp(2);
    expect((await app.request('/health')).status).toBe(200);
    const board = await app.request('/board');
    expect(board.status).toBe(200);
    expect(await board.json()).toHaveProperty('lists');
  });

  it('leaves a root path that is not code-shaped alone', async () => {
    const { app } = await shareApp(2);
    // the ops shell answers "/" — the share router must not have claimed it
    expect((await app.request('/')).headers.get('content-type')).toMatch(/text\/html/);
    expect((await app.request('/not-a-code')).status).toBe(404);
  });
});

// Render (and any other proxy) terminates TLS at the edge, so the request URL the app
// sees is plain http. Building og:url / og:image from it emitted http:// links on a site
// served over https — which crawlers variously downgrade, ignore, or refuse outright,
// costing exactly the preview this whole endpoint exists to produce.
describe('absolute URLs behind a TLS-terminating proxy', () => {
  it('honours x-forwarded-proto when building og tags', async () => {
    const { app, code } = await seeded(5);
    const res = await app.request(`/r/${code}`, { headers: { 'x-forwarded-proto': 'https' } });
    const html = await res.text();

    expect(meta(html, 'og:image')).toMatch(/^https:\/\//);
    expect(meta(html, 'og:url')).toMatch(/^https:\/\//);
    expect(html).not.toContain('content="http://');
  });

  it('leaves plain http alone when nothing is proxying (local dev)', async () => {
    const { app, code } = await seeded(5);
    const html = await (await app.request(`/r/${code}`)).text();
    expect(meta(html, 'og:image')).toMatch(/^http:\/\/localhost/);
  });

  it('an explicit share host still wins over both', async () => {
    const rideLists = new InMemoryRideListRepo();
    const l = await rideLists.createList(listArgs());
    await rideLists.addMember(l.id, { sub: 's', firstName: 'Ann', country: 'PL', email: 'a@b.com', seats: 1 });
    const app = createApp({
      rideLists,
      bookingBaseUrl: 'https://prod.ceylonhop.com',
      shareBaseUrl: 'https://ride.ceylonhop.com',
    });
    const html = await (await app.request(`/r/${l.code}`, { headers: { 'x-forwarded-proto': 'http' } })).text();
    expect(meta(html, 'og:url')).toBe(`https://ride.ceylonhop.com/r/${l.code}`);
  });
});

// The story kit (proposal 2026-10-23): ops posts a new ride as an Instagram story by hand.
// A story is a 9:16 portrait, so the 1200x630 chat card would crop to a sliver.
describe('GET /r/:code/story.png — the Instagram story image', () => {
  const pngSize = (bytes: Uint8Array) => {
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    return { w: v.getUint32(16), h: v.getUint32(20) }; // IHDR, right after the 8-byte signature
  };

  it('renders a 1080x1920 PNG', async () => {
    const { app, code } = await seeded(2);
    const res = await app.request(`/r/${code}/story.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(1, 4)).map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
    expect(pngSize(bytes)).toEqual({ w: 1080, h: 1920 });
    expect(bytes.length).toBeGreaterThan(30_000); // blank canvases rasterise tiny
  });

  it('404s for a code that does not exist', async () => {
    const { app } = await seeded(2);
    expect((await app.request('/r/ZZ-9999/story.png')).status).toBe(404);
  });

  it('is served at the share-domain root too', async () => {
    const { app, code } = await seeded(2);
    expect((await app.request(`/${code}/story.png`)).status).toBe(200);
  });
});

// Owner call 2026-10-23: the story goes on a public brand account, not a chat the traveller
// chose, so it carries counts only — no names, no initials.
describe('storySvg — counts only', () => {
  it('says how many are in and how many more it needs, without a single name or initial', async () => {
    const rideLists = new InMemoryRideListRepo();
    const l = await rideLists.createList(listArgs());
    await rideLists.addMember(l.id, { sub: 's1', firstName: 'Anna', country: 'PL', email: 'a@secret.com', seats: 1 });
    await rideLists.addMember(l.id, { sub: 's2', firstName: 'Yuki', country: 'JP', email: 'y@secret.com', seats: 1 });
    const found = (await rideLists.getByCode(l.code))!;

    const svg = storySvg(storyModel(found, rideCopy(found)));

    expect(svg).toContain('2 more and it rolls'); // minSeats 4, 2 in
    expect(svg).toContain('2 on board');
    expect(svg).toContain('Dambulla');
    for (const leak of ['Anna', 'Yuki', '>AN<', '>YU<', 'PL', 'JP', 'secret.com']) {
      expect(svg).not.toContain(leak);
    }
  });
});

// Tagged links (utm_*) let GA4 say which post brought a visitor. /r/:code forwards a human
// to the board by script, and that hop used to drop the query string.
describe('GET /r/:code — campaign tags survive the hop to the board', () => {
  it('carries utm_* tags on to the board URL, ahead of the ride fragment', async () => {
    const { app, code } = await seeded(2);
    const html = await (await app.request(`/r/${code}?utm_source=instagram&utm_medium=story&utm_campaign=ride_board`)).text();
    expect(html).toContain(`https://prod.ceylonhop.com/board.html?utm_source=instagram&utm_medium=story&utm_campaign=ride_board#/${code}`);
  });

  it('keeps only utm_* keys with plain values, and leaves the canonical URL untagged', async () => {
    const { app, code } = await seeded(2);
    const html = await (await app.request(`/r/${code}?utm_source=telegram&next=https://evil.example&utm_medium=%3Cscript%3E`)).text();
    expect(html).toContain(`board.html?utm_source=telegram#/${code}`);
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('<script>alert');
    expect(meta(html, 'og:url')).toMatch(new RegExp(`/r/${code}$`));
  });

  it('adds nothing when the link has no tags', async () => {
    const { app, code } = await seeded(2);
    const html = await (await app.request(`/r/${code}`)).text();
    expect(html).toContain(`https://prod.ceylonhop.com/board.html#/${code}`);
  });
});
