import { Hono } from 'hono';
import { aboutKm, toPublicExperience } from '../experiences/experience';
import { matchExperiences, type StopPoint } from '../experiences/match';
import type { ExperienceRepo } from '../db/experienceRepo';

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

export function publicExperiencesRoutes(deps: { experiences: ExperienceRepo }) {
  const r = new Hono();

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

  return r;
}
