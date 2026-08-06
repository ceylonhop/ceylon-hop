import { describe, it, expect } from 'vitest';
import { shortPlace, shortenRouteLabel } from './shortPlace';

describe('shortPlace', () => {
  it('drops the street and the country', () => {
    expect(shortPlace('The Den 23, Norris Canal Road, Colombo, Sri Lanka')).toBe('The Den 23 · Colombo');
    expect(shortPlace('Deltora Villa, Bope Cross Road, Galle, Sri Lanka')).toBe('Deltora Villa · Galle');
  });

  it('keeps the venue alone when it already names its town', () => {
    expect(shortPlace('Ella Mount View Guest Inn, Waterfall Road, Ella, Sri Lanka')).toBe('Ella Mount View Guest Inn');
    expect(shortPlace('Dambulla Cave Temple, Kandy - Jaffna Highway, Dambulla, Sri Lanka')).toBe('Dambulla Cave Temple');
  });

  // "Umbrella Cafe" CONTAINS "ella" — a substring test would silently drop the town and leave a
  // customer unable to tell which town they're collected in. Match whole words only.
  it('does not mistake a town for part of a longer word', () => {
    expect(shortPlace('Umbrella Cafe, Main Street, Ella, Sri Lanka')).toBe('Umbrella Cafe · Ella');
    expect(shortPlace('Bellagio Hotel, Galle Road, Ella, Sri Lanka')).toBe('Bellagio Hotel · Ella');
  });

  it('leaves a name that is already short alone', () => {
    expect(shortPlace('Arugam Bay Beach, Sri Lanka')).toBe('Arugam Bay Beach');
    expect(shortPlace('Colombo Airport (CMB)')).toBe('Colombo Airport (CMB)');
  });

  it('passes free text through rather than chopping it', () => {
    expect(shortPlace('the blue house past the temple')).toBe('the blue house past the temple');
  });

  it('is a pure function of ONE string — no set, no order, no state', () => {
    const a = 'Villa Sunshine, Temple Road, Galle, Sri Lanka';
    expect(shortPlace(a)).toBe(shortPlace(a));
    // Two same-named villas in one town DO collide. Accepted: rare, same town, and ops always
    // sees the full string in the editable field. The alternative was a place registry.
    expect(shortPlace('Villa Sunshine, Lake Road, Galle, Sri Lanka')).toBe(shortPlace(a));
  });

  it('never throws on empty or odd input', () => {
    expect(shortPlace('')).toBe('');
    expect(shortPlace('   ')).toBe('');
    expect(shortPlace(',,,')).toBe(',,,');
    expect(shortPlace(undefined as unknown as string)).toBe('');
  });
});

describe('shortenRouteLabel', () => {
  // The engine bakes "A → B (car)" into result.lineItems at pricing time. Shortening happens at
  // RENDER, so stored quotes are untouched and every existing quote improves with no migration.
  it('shortens each side and keeps the vehicle suffix', () => {
    expect(shortenRouteLabel('The Den 23, Norris Canal Road, Colombo, Sri Lanka → Sigiri dilu villa, Thalkote Road, Sigiriya, Sri Lanka (car)'))
      .toBe('The Den 23 · Colombo → Sigiri dilu villa · Sigiriya (car)');
  });

  it('handles a multi-stop chain', () => {
    expect(shortenRouteLabel('Colombo Airport (CMB) → Dambulla Cave Temple, Kandy - Jaffna Highway, Dambulla, Sri Lanka → Sigiriya, Sri Lanka (van9)'))
      .toBe('Colombo Airport (CMB) → Dambulla Cave Temple → Sigiriya (van9)');
  });

  it('leaves a label with no route in it alone', () => {
    expect(shortenRouteLabel('Final price adjustment')).toBe('Final price adjustment');
    expect(shortenRouteLabel('Luggage rack — Kandy → Ella')).toBe('Luggage rack — Kandy → Ella');
  });

  it('never throws on empty', () => {
    expect(shortenRouteLabel('')).toBe('');
  });
});
