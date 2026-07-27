import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';

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
