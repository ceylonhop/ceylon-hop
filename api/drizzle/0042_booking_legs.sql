-- One record per journey in a booking (spec 2026-08-08 §1). A journey is currently a POSITION
-- between two entries in trip_request.stops[], so anything attached to it silently follows the
-- position when the trip changes — insert a stop and every later journey wears the previous
-- occupant's details, with nothing on any screen looking wrong.
--
-- This table prices nothing. trip_request / transfer_request stay the priced record; the two agree
-- at booking time and may legitimately diverge afterwards, and flattening them would erase why the
-- price is what it is.
--
-- Table only, deliberately: no data moves here. Migrations auto-apply on Render boot and fail
-- closed, so backfilling inside one could take the API down over a single malformed historical row.
-- The backfill is scripts/backfill-booking-legs.ts, run deliberately.
CREATE TABLE "booking_legs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "booking_id" uuid NOT NULL REFERENCES "bookings"("id"),
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  "from_place" text NOT NULL,
  "to_place" text NOT NULL,
  "via_stops" text[] DEFAULT '{}'::text[] NOT NULL,
  "travel_date" text,
  "from_lat" double precision,
  "from_lng" double precision,
  "to_lat" double precision,
  "to_lng" double precision,
  "pickup_spot" text,
  "dropoff_spot" text,
  "pickup_lat" double precision,
  "pickup_lng" double precision,
  "dropoff_lat" double precision,
  "dropoff_lng" double precision,
  "pickup_time" text,
  "flight_no" text,
  "detail_flag" text,
  "distance_check" text,
  "refused_spot" text,
  "refused_at" timestamptz,
  "details_history" jsonb,
  "details_updated_at" timestamptz,
  "removed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "booking_legs_booking_seq_unique" UNIQUE ("booking_id", "seq"),
  CONSTRAINT "booking_legs_kind_valid" CHECK ("kind" in ('leg', 'day', 'gap')),
  CONSTRAINT "booking_legs_seq_positive" CHECK ("seq" > 0)
);
CREATE INDEX "booking_legs_booking_idx" ON "booking_legs" ("booking_id");
