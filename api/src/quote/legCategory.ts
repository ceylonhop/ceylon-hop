// Design leg categories. `drives` = the vehicle moves that day (km-priced); stay_day is idle.
//
// Shared source of truth for internalQuote.ts (pricing/service-chooser) and quoteView.ts (the
// customer link's chauffeur-offerability check) — both need to agree on which categories drive,
// and hand-copying that knowledge risks a silent divergence: add a new non-driving category here
// and every importer picks it up; a hardcoded copy elsewhere would not.
export const CATEGORIES: Record<string, { drives: boolean }> = {
  transfer: { drives: true },
  airport: { drives: true },
  train_support: { drives: true },
  stay_day: { drives: false },
};

export function drives(l: { category?: string }): boolean {
  return CATEGORIES[l.category || 'transfer']?.drives ?? true;
}
