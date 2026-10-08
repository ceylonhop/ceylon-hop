import { Hono } from 'hono';
import { aboutKm, toPublicExperience } from '../experiences/experience';
import { matchExperiences, type StopPoint } from '../experiences/match';
import type { ExperienceRepo } from '../db/experienceRepo';
import { NullTripadvisorAdapter, type TripadvisorAdapter } from '../adapters/tripadvisor';

// Public, cacheable read for the booking page (spec 2026-10-06 D7): which active experiences are near
// each drop-off. The browser sends labelled points (`at=Sigiriya@7.95,80.76`); the matcher is the same
// pure function the quote page calls in-process, so the two pages cannot disagree about "near".
// Only toPublicExperience fields leave here — never the partner contact, the pin or the audit trail.
const AT = /^(.{1,60})@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const MAX_STOPS = 8;

// Sri Lanka's box (same bounds as the catalogue input): a swapped "lng,lat" falls outside it.
function parseStop(raw: string): StopPoint | null {
  const m = AT.exec(raw);
  if (!m) return null;
  const label = m[1]!.trim();
  const lat = Number(m[2]);
  const lng = Number(m[3]);
  if (!label || !(lat >= 5.8 && lat <= 10.0) || !(lng >= 79.4 && lng <= 82.0)) return null;
  return { label, lat, lng };
}

const MAX_RATING_IDS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function publicExperiencesRoutes(deps: { experiences: ExperienceRepo; tripadvisor?: TripadvisorAdapter; tripadvisorLogoUrl?: string }) {
  const r = new Hono();
  const tripadvisor = deps.tripadvisor ?? new NullTripadvisorAdapter();

  r.get('/near', async (c) => {
    const at = c.req.queries('at') ?? [];
    const stops = at.map(parseStop);
    if (at.length < 1 || at.length > MAX_STOPS || stops.some((s) => !s)) return c.json({ error: 'bad_request' }, 400);
    const matched = matchExperiences(stops as StopPoint[], await deps.experiences.listActive());
    c.header('cache-control', 'public, max-age=300');
    return c.json({
      stops: matched.map((s) => ({
        place: s.place,
        items: s.items.map((m) => ({ ...toPublicExperience(m.experience), aboutKm: aboutKm(m.distanceKm) })),
      })),
    });
  });

  // Live Tripadvisor ratings (spec D22). Tripadvisor's terms forbid keeping the rating, so each request asks
  // Tripadvisor afresh (in parallel) and nothing is cached - here or by the browser. The id is looked up
  // server-side from the experience, so a caller cannot make us query an arbitrary Tripadvisor location.
  r.get('/ratings', async (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').map((s) => s.trim());
    if (ids.length < 1 || ids.length > MAX_RATING_IDS || ids.some((id) => !UUID.test(id))) return c.json({ error: 'bad_request' }, 400);
    c.header('cache-control', 'no-store');
    // No key or no logo, no ratings: answer without a database read (the page asks on every view). Tripadvisor's
    // display rules need their logo beside every bubble, so a rating is never returned without one.
    if (tripadvisor instanceof NullTripadvisorAdapter || !deps.tripadvisorLogoUrl) return c.json({ ratings: [] });
    const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
    const rows = new Map((await deps.experiences.getMany(wanted)).map((e) => [e.id, e]));
    const found = await Promise.all(wanted.map(async (id) => {
      const e = rows.get(id);
      if (!e || !e.active || !e.tripadvisorLocationId) return null;
      const d = await tripadvisor.details(e.tripadvisorLocationId);
      return d ? { id: e.id, rating: d.rating, numReviews: d.numReviews, ratingImageUrl: d.ratingImageUrl, webUrl: d.webUrl } : null;
    }));
    const ratings = found.filter((x) => x !== null);
    return c.json(ratings.length ? { logoUrl: deps.tripadvisorLogoUrl, ratings } : { ratings });
  });

  return r;
}
