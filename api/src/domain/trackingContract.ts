/**
 * Phase A tracking vocabulary.
 *
 * These constants are deliberately free of persistence and delivery behaviour. They pin the
 * words that later schema, repository, webhook and Ops-timeline slices must share, without
 * changing how a booking moves or how an email is sent.
 */

export const TRACKED_BOOKING_EMAIL_KINDS = [
  'confirmation',
  'details_needed',
  'booking_confirmed',
  'cancellation',
  'refund',
  'no_show_notice',
  'trip_reminder',
  'review_request',
  'payment_recovery',
  'payment_failed',
  'deposit_received',
] as const;

export type TrackedBookingEmailKind = (typeof TRACKED_BOOKING_EMAIL_KINDS)[number];

// Provider acceptance and delivery are separate facts. In particular, a successful Resend API
// response is `provider_accepted`; only a signed provider webhook may write `delivered`.
export const CUSTOMER_COMMUNICATION_EVENT_TYPES = [
  'planned',
  'send_attempted',
  'provider_accepted',
  'send_failed',
  'suppressed',
  'provider_sent',
  'delivered',
  'delayed',
  'provider_failed',
  'bounced',
  'complained',
] as const;

export type CustomerCommunicationEventType = (typeof CUSTOMER_COMMUNICATION_EVENT_TYPES)[number];

export const BOOKING_TRANSITION_SOURCES = [
  'website',
  'ops',
  'payment_webhook',
  'quote_conversion',
  'refund',
  'scheduled_job',
  'migration',
  'system',
] as const;

export type BookingTransitionSource = (typeof BOOKING_TRANSITION_SOURCES)[number];

export const BOOKING_TRANSITION_ACTOR_TYPES = [
  'customer',
  'staff',
  'provider',
  'scheduler',
  'migration',
  'system',
] as const;

export type BookingTransitionActorType = (typeof BOOKING_TRANSITION_ACTOR_TYPES)[number];

export const BOOKING_TRANSITION_RELATED_ENTITY_TYPES = [
  'payment',
  'refund',
  'quote',
  'fulfilment',
] as const;

export type BookingTransitionRelatedEntityType =
  (typeof BOOKING_TRANSITION_RELATED_ENTITY_TYPES)[number];

export interface TrackingCorrelation {
  requestId?: string;
  runId?: string;
}

export interface BookingTransitionContext extends TrackingCorrelation {
  source: BookingTransitionSource;
  actorType: BookingTransitionActorType;
  actorId?: string;
  reason?: string;
  relatedEntityType?: BookingTransitionRelatedEntityType;
  relatedEntityId?: string;
}

