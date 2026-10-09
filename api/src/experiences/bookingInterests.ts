import type { ExperienceInterest, ExperienceInterestRepo } from '../db/experienceInterestRepo';
import type { ExperienceRepo } from '../db/experienceRepo';
import type { Experience } from './experience';

export interface BookingInterest {
  interest: ExperienceInterest;
  /** null when the catalogue row has gone; the interest keeps its own name snapshot. */
  experience: Experience | null;
}

// A paid booking's experience interests with their catalogue rows (spec 2026-10-06 D15). The ops
// sheet and the team's paid email both show these as a courtesy, so a lookup that fails must
// cost neither of them anything: it logs and returns [].
export async function loadBookingInterests(
  deps: { experiences?: ExperienceRepo; experienceInterests?: ExperienceInterestRepo },
  bookingId: string,
): Promise<BookingInterest[]> {
  if (!deps.experienceInterests) return [];
  try {
    const interests = await deps.experienceInterests.listForBooking(bookingId);
    if (interests.length === 0) return [];
    const found = deps.experiences ? await deps.experiences.getMany(interests.map((i) => i.experienceId)) : [];
    const byId = new Map(found.map((e) => [e.id, e]));
    return interests.map((interest) => ({ interest, experience: byId.get(interest.experienceId) ?? null }));
  } catch (err) {
    console.error(`[experiences] interests unavailable for booking ${bookingId}:`, err);
    return [];
  }
}

// A quote's "interested" ticks follow it into the booking it becomes (spec 2026-10-06 D12), so the
// lead is worked once, against the paid booking. Called after each point a quote converts; a
// courtesy, so a failure is logged and never fails the conversion.
export async function linkQuoteInterests(
  repo: ExperienceInterestRepo | undefined,
  quoteId: string,
  bookingId: string,
): Promise<void> {
  if (!repo) return;
  try {
    await repo.linkQuoteToBooking(quoteId, bookingId);
  } catch (err) {
    console.error(`[experiences] could not link quote ${quoteId} interests to booking ${bookingId}:`, err);
  }
}
