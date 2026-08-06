import { describe, it, expect } from 'vitest';
import { customerQuoteView } from './customerQuoteView';

const quote = (over: Record<string, unknown> = {}) => ({
  reference: 'Q-7F3KX',
  customerName: 'Anna Bergström',
  vehicle: 'car',
  totalCents: 84_000,
  requestedService: 'private',
  request: {
    engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
    tool: {
      passengerCount: 2,
      legs: [
        { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
        { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
      ],
    },
  },
  ...over,
});

const both = { pointToPoint: { totalCents: 84_000 }, chauffeur: { totalCents: 118_000 } };
const p2pOnly = { pointToPoint: { totalCents: 84_000 }, chauffeur: null };

describe('customerQuoteView', () => {
  it('never emits margin on any path', () => {
    const v = customerQuoteView(
      quote({ marginCents: 31_000, rateCardJson: { costPerKmCents: 40 }, requestedService: 'both' }),
      both,
    );
    const s = JSON.stringify(v);
    expect(s).not.toMatch(/margin/i);
    expect(s).not.toMatch(/rateCard|costPerKm|markup|hotZone/i);
  });

  it('shows one option for a `private` quote, even when chauffeur is priceable', () => {
    const v = customerQuoteView(quote(), both);
    expect(v.options).toHaveLength(1);
    expect(v.options[0]).toMatchObject({ service: 'private', lead: true, totalUsd: '$840', deltaUsd: null });
  });

  it('shows both options for a `both` quote, priced service leading', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options.map((o) => o.service)).toEqual(['private', 'chauffeur']);
    expect(v.options[0].lead).toBe(true);
    expect(v.options[1].lead).toBe(false);
    expect(v.options[1].totalUsd).toBe('$1,180');
  });

  it('quantifies the delta on the non-priced option', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options[1].deltaUsd).toBe('+$340');
    expect(v.options[1].deltaText).toBe('+$340 — your driver stays with you throughout');
  });

  it('degrades to one card when chauffeur cannot be priced on a `both` quote', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), p2pOnly);
    expect(v.options).toHaveLength(1);
    expect(v.options[0].service).toBe('private');
    expect(v.heroTotalNote).not.toMatch(/or \$/);
  });

  it('names both numbers in the hero note on a two-option quote', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.heroTotalUsd).toBe('$840');
    expect(v.heroTotalNote).toBe('private transfers · or $1,180 with your driver throughout');
  });

  it('gives each service its own cancellation ladder', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options[0].cancellation.headline).toBe('Free cancellation up to 24 hours before');
    expect(v.options[1].cancellation.headline).toBe('Free cancellation up to 10 days before');
    expect(v.options[1].cancellation.ladder.join(' ')).toMatch(/80%/);
  });

  it('prefills WhatsApp with the reference and the tapped option', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options[1].waText).toBe(
      "Hi! I'd like to book the Chauffeur & guide option for quote Q-7F3KX",
    );
    expect(v.waText).toContain('Q-7F3KX');
  });

  it('exposes the ordered map stops and trip stats', () => {
    const v = customerQuoteView(quote(), p2pOnly);
    expect(v.mapStops).toEqual(['Colombo Airport', 'Sigiriya', 'Kandy']);
    expect(v.totalKm).toBe(260);
    expect(v.travelDays).toBe(2);
  });

  it('renders a legacy quote with no engine without throwing', () => {
    const v = customerQuoteView(quote({ request: {} }), { pointToPoint: { totalCents: 84_000 }, chauffeur: null });
    expect(v.options).toHaveLength(1);
    expect(v.days).toEqual([]);
    expect(v.mapStops).toEqual([]);
  });

  // Correction 1: heroTotalNote must describe the SECONDARY option's own service, not always
  // assume the secondary is chauffeur. When ops priced chauffeur and private is the cheaper
  // alternative, "with your driver throughout" would misdescribe the point-to-point option.
  it('names the hero note correctly when the priced service is chauffeur', () => {
    const chauffeurQuote = quote({
      requestedService: 'both',
      totalCents: 118_000,
      request: {
        engine: { product: 'chauffeur', firstDate: '2026-08-20', lastDate: '2026-08-28' },
        tool: {
          passengerCount: 2,
          legs: [
            { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
            { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
          ],
        },
      },
    });
    const v = customerQuoteView(chauffeurQuote, both);
    expect(v.options.map((o) => o.service)).toEqual(['chauffeur', 'private']);
    expect(v.heroTotalUsd).toBe('$1,180');
    expect(v.heroTotalNote).toBe('chauffeur & guide · or $840 travelling journey by journey');
  });

  // Correction 2: a legacy row with requestedService: null must render exactly one option
  // (the priced one) and must not throw — the brief only covers 'private' and 'both'.
  it('renders exactly one option for a legacy quote with requestedService null', () => {
    const v = customerQuoteView(quote({ requestedService: null }), both);
    expect(v.options).toHaveLength(1);
    expect(v.options[0].service).toBe('private');
    expect(v.options[0].lead).toBe(true);
  });
});
