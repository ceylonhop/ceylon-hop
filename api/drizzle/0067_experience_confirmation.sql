-- Experience confirmation email (spec 2026-10-06 D21). Hand-written: drizzle-kit generate needs a TTY.
-- The experience happens in Sri Lanka at a wall-clock time the partner gave us, so the schedule is a
-- date + an "HH:MM" string, not a timestamptz (an instant invites a timezone shift between ops, the
-- email and the customer). Nullable ADD COLUMNs with no default: no table rewrite, existing rows untouched.
ALTER TABLE "experience_interests" ADD COLUMN "scheduled_date" date;
--> statement-breakpoint
ALTER TABLE "experience_interests" ADD COLUMN "scheduled_time" text;
--> statement-breakpoint
ALTER TABLE "experience_interests" ADD COLUMN "meeting_point" text;
--> statement-breakpoint
ALTER TABLE "experience_interests" ADD COLUMN "confirmation_sent_at" timestamp with time zone;
--> statement-breakpoint
-- How the customer was told: the email we sent, or ops confirmed it by WhatsApp (a quote-only lead
-- often has only a phone number, so without this it could never leave the Leads list).
ALTER TABLE "experience_interests" ADD COLUMN "confirmation_channel" text;
--> statement-breakpoint
ALTER TABLE "experience_interests" ADD CONSTRAINT "experience_interests_time_valid" CHECK ("scheduled_time" is null or "scheduled_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
--> statement-breakpoint
ALTER TABLE "experience_interests" ADD CONSTRAINT "experience_interests_meeting_point_length" CHECK ("meeting_point" is null or char_length("meeting_point") <= 200);
--> statement-breakpoint
ALTER TABLE "experience_interests" ADD CONSTRAINT "experience_interests_confirmation_channel_valid" CHECK ("confirmation_channel" is null or "confirmation_channel" in ('email', 'whatsapp'));
