import { pgTable, uuid, text, integer, boolean, timestamp, unique, jsonb, doublePrecision } from 'drizzle-orm/pg-core';

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull(),
  phoneCountryCode: text('phone_country_code'),
  phoneNumber: text('phone_number'),
  whatsapp: text('whatsapp').notNull(),
  country: text('country').notNull(),
  marketingOptIn: boolean('marketing_opt_in'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id),
  reference: text('reference').notNull().unique(),
  status: text('status').notNull(),
  mode: text('mode').notNull().default('single'),
  total: integer('total').notNull(),
  // What checkout collects now. Nullable: older rows may have no value and are charged
  // the full total.
  amountDueNow: integer('amount_due_now'),
  currency: text('currency').notNull(),
  idempotencyKey: text('idempotency_key').unique(),
  // M12 Slice 2 — where the booking came from. Only 'website' is written today; a future
  // payment-link tool will write 'whatsapp'.
  channel: text('channel').notNull().default('website'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const transferRequests = pgTable('transfer_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .unique()
    .references(() => bookings.id),
  fromPlace: text('from_place').notNull(),
  toPlace: text('to_place').notNull(),
  travelDate: text('travel_date'),
  travelTime: text('travel_time'),
  vehicleType: text('vehicle_type').notNull(),
  adults: integer('adults').notNull(),
  children: integer('children').notNull(),
  bags: integer('bags').notNull(),
  // M8 — road distance + driving duration from the maps adapter. Null when unresolved.
  distanceKm: integer('distance_km'),
  durationMin: integer('duration_min'),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  provider: text('provider').notNull(),
  orderId: text('order_id').notNull().unique(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conciergeTasks = pgTable('concierge_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  type: text('type').notNull(),
  status: text('status').notNull(),
  // Optional free-text context for the staff member (GL-3, e.g. a price-mismatch detail).
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// v1 stores the multi-stop trip as arrays (stops/nights/dates) rather than the fully
// normalised itinerary/leg/stay of spec §5.2 — fine for the stub, normalise later.
export const tripRequests = pgTable('trip_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .unique()
    .references(() => bookings.id),
  serviceType: text('service_type').notNull(),
  pax: integer('pax').notNull(),
  vehicleType: text('vehicle_type').notNull(),
  stops: text('stops').array().notNull(),
  nights: integer('nights').array().notNull(),
  dates: text('dates').array(),
  // Chauffeur-guide only: car-retention days (start→end inclusive) and driver
  // accommodation nights (days − 1). Null for point-to-point transfers.
  days: integer('days'),
  driverNights: integer('driver_nights'),
});

export const corridors = pgTable('corridor', {
  id: text('id').primaryKey(),
  fromPlace: text('from_place').notNull(),
  toPlace: text('to_place').notNull(),
  seatPrice: integer('seat_price').notNull(),
  seatCapacity: integer('seat_capacity').notNull(),
});

// Inventory for the shared service (a fixed weekly schedule, not daily — corridors run
// only on their service weekdays). The unique (corridor,date,time) lets us upsert the
// departure, and the atomic seat-hold updates seats_booked under a row lock.
export const sharedDepartures = pgTable(
  'shared_departure',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    corridorId: text('corridor_id')
      .notNull()
      .references(() => corridors.id),
    date: text('date').notNull(),
    time: text('time').notNull(),
    seatsTotal: integer('seats_total').notNull(),
    seatsBooked: integer('seats_booked').notNull().default(0),
  },
  (t) => [unique().on(t.corridorId, t.date, t.time)],
);

export const sharedRequests = pgTable('shared_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .unique()
    .references(() => bookings.id),
  corridorId: text('corridor_id')
    .notNull()
    .references(() => corridors.id),
  date: text('date').notNull(),
  time: text('time').notNull(),
  seats: integer('seats').notNull(),
});

// ---- Ops layer (M12 Slice 1). References read-only website bookings; never mutated by
// the booking flow. The ops dashboard owns these tables.
export const rideOps = pgTable('ride_ops', {
  bookingId: uuid('booking_id')
    .primaryKey()
    .references(() => bookings.id),
  fulfilmentStatus: text('fulfilment_status').notNull().default('paid'),
  vehiclePhotoReceived: boolean('vehicle_photo_received').notNull().default(false),
  customerUpdated: boolean('customer_updated').notNull().default(false),
  opsNotes: text('ops_notes'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  vehicleConfirmedAt: timestamp('vehicle_confirmed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Dedup ledger for scheduled customer notifications (M14): one row per (booking, kind)
// means the cron tick can run as often as it likes without ever double-sending.
// Display names for ops staff, captured from the Google profile at sign-in so the assign
// picker and queue name people rather than inboxes. Email is the key, NOT a foreign key:
// staff identity/role lives in OPS_USERS (env), so a row here is a cache of what Google told
// us, and dropping this table costs labels, not access. No row until that person signs in.
export const opsUserProfiles = pgTable('ops_user_profiles', {
  email: text('email').primaryKey(),
  name: text('name').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// M17 — ops-alert dedupe ledger. One row per (kind, dedupe_key); ThrottledAlerts only
// delivers when last_sent_at is older than the cooldown, so alert storms collapse and a
// restart/redeploy can't re-spam the founder. count tracks suppressed repeats.
export const alertLog = pgTable(
  'alert_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(1),
  },
  (t) => ({ kindKey: unique().on(t.kind, t.dedupeKey) }),
);

export const notificationLog = pgTable(
  'notification_log',
  {
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    kind: text('kind').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ bookingKind: unique().on(t.bookingId, t.kind) }),
);

// M11 quote lifecycle — every price the internal quoting tool hands out. request_json /
// result_json store the engine I/O verbatim (replayable; freezes the quoted price even
// if the rate card changes). converted_booking_id is a nullable bridge, populated later.
export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  reference: text('reference').notNull().unique(),
  channel: text('channel').notNull().default('ops'),
  status: text('status').notNull().default('draft'),
  lostReason: text('lost_reason'),
  product: text('product').notNull(),
  vehicle: text('vehicle'),
  customerName: text('customer_name'),
  customerContact: text('customer_contact'),
  totalCents: integer('total_cents').notNull(),
  currency: text('currency').notNull(),
  rateCardVersion: text('rate_card_version').notNull(),
  marginCents: integer('margin_cents'),
  requestJson: jsonb('request_json').notNull(),
  resultJson: jsonb('result_json').notNull(),
  // Rate-lock (spec 2026-07-11): the RATE_CARD snapshot this quote is priced against + when that
  // lock expires. Nullable — existing/legacy rows have no lock and re-price on the current card.
  rateCardJson: jsonb('rate_card_json'),
  rateLockedUntil: timestamp('rate_locked_until', { withTimezone: true }),
  convertedBookingId: uuid('converted_booking_id').references(() => bookings.id),
  notes: text('notes'),
  // Internal ops notes (spec 2026-07-22): a free-text scratchpad on the quote, distinct from
  // `notes` (which carries the founder's send-back reason surfaced in the review banner). Kept
  // separate so an ops person jotting trip context can never clobber a send-back reason and
  // vice-versa. Nullable; never shown to the customer.
  internalNotes: text('internal_notes'),
  // Quote intent (spec 2026-07-17): which service the CUSTOMER asked for — 'private' |
  // 'chauffeur' | 'both' — as distinct from `product`, which is what was actually priced.
  // Nullable: rows predating this have none, and the requirement is a workflow gate at submit
  // (internalQuote's PATCH), not a storage constraint. There is no 'legacy' sentinel — every
  // quote is gated, old ones included (spec I7).
  requestedService: text('requested_service'),
  // Assignment + audit (spec 2026-07-16). assignedTo is the notification target: who HOLDS the
  // quote, set only by an explicit assign — never inferred from who last moved it. All nullable:
  // rows predating this can't be backfilled (we don't know who made them). Emails, not FKs —
  // staff live in OPS_USERS (env), not a table, and the route validates against it.
  assignedTo: text('assigned_to'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  // Soft delete (spec 2026-07-22): a deleted quote is hidden from get()/list() but retained in the
  // table (never a hard wipe — keeps the audit trail and lets a mistaken delete be recovered).
  // Role-gated in the route: ops delete drafts, founders delete locked-but-unsent; sent quotes
  // can never be deleted.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

// Rate-card HOT ZONES (spec 2026-07-22): a founder-editable list of premium towns. When a priced
// trip touches one (by name, per the D3 matching rules), its per-km rate is boosted by boost_pct.
// place_name is a KNOWN_PLACES town (the match key). The optional lat/lng/radius_km trio is a geo
// fallback for GPS pickups the names miss. created_by/updated_by are staff emails (pricing changes
// are never anonymous), matching the audit pattern quotes gained in migration 0015.
export const pricingZones = pgTable('pricing_zones', {
  id: uuid('id').primaryKey().defaultRandom(),
  placeName: text('place_name').notNull(),
  boostPct: integer('boost_pct').notNull(),
  active: boolean('active').notNull().default(true),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  radiusKm: doublePrecision('radius_km'),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
