import { describe, expect, it } from 'vitest';
import {
  BOOKING_TRANSITION_ACTOR_TYPES,
  BOOKING_TRANSITION_RELATED_ENTITY_TYPES,
  BOOKING_TRANSITION_SOURCES,
  CUSTOMER_COMMUNICATION_EVENT_TYPES,
  TRACKED_BOOKING_EMAIL_KINDS,
} from './trackingContract';

describe('Phase A tracking contract', () => {
  it('freezes the booking email kinds in the initial tracking scope', () => {
    expect(TRACKED_BOOKING_EMAIL_KINDS).toEqual([
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
    ]);
  });

  it('keeps provider acceptance separate from provider delivery', () => {
    expect(CUSTOMER_COMMUNICATION_EVENT_TYPES).toEqual([
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
    ]);
  });

  it('freezes provenance vocabulary for applied booking transitions', () => {
    expect(BOOKING_TRANSITION_SOURCES).toEqual([
      'website',
      'ops',
      'payment_webhook',
      'quote_conversion',
      'refund',
      'scheduled_job',
      'migration',
      'system',
    ]);
    expect(BOOKING_TRANSITION_ACTOR_TYPES).toEqual([
      'customer',
      'staff',
      'provider',
      'scheduler',
      'migration',
      'system',
    ]);
    expect(BOOKING_TRANSITION_RELATED_ENTITY_TYPES).toEqual([
      'payment',
      'refund',
      'quote',
      'fulfilment',
    ]);
  });
});
