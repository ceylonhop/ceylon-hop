// The manual settlement channels ops can record with POST /admin/bookings/:id/mark-paid.
// One source of truth on purpose: the route's request schema, the watchdog's "was this
// settled by hand?" test, and the `payments_provider_supported` CHECK (drizzle/0029 +
// scripts/preflight-money-constraints.ts) all have to agree on this list, and a channel
// added to one but not the others is exactly how a green test suite meets a 23514 in prod.
export const MANUAL_PAYMENT_METHODS = ['cash', 'bank_transfer', 'manual_other'] as const;

export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

// Asking "did this money arrive by hand?" is deliberately NOT a provider-name test — the
// payment row records its own provenance and `paymentRepo.hasManualSettlement()` reads that.
// A name check would quietly answer wrong the first time this list and the row disagree.
