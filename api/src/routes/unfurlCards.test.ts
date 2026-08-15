import { describe, it, expect } from 'vitest';
import { payCardSvg, GENERIC_PAY_CARD } from './payCard';
import { quoteCardSvg, GENERIC_QUOTE_CARD } from './quoteCard';
import { brandMark, markWidth, BRAND_MARK_PATH } from './shareCardImage';

/*
  The two OG cards a customer meets before they meet the page: the quote link's and the pay
  link's. Both are rasterised by resvg with no system fonts and no DOM, so everything here is a
  string assertion on the SVG — which is exactly why the SVG is built as a string.

  Owner, 2026-08-10, on the live unfurls: "the unfurl does not show the actual logos, also the
  unfurl looks exactly the same for quote and pay, there needs to be a tiny dif so people don't
  confuse the two." Both halves of that are pinned below.
*/

const TRIP = {
  lead: 'Your trip is ready to confirm',
  route: 'Three journeys, 28 August – 4 September',
  detail: 'Private car · 2 travellers',
};
const CARDS = [
  { name: 'pay', svg: payCardSvg(TRIP) },
  { name: 'quote', svg: quoteCardSvg({ ...TRIP, lead: 'Nicole, your trip is ready' }) },
];

describe('both unfurl cards carry the real brand mark', () => {
  for (const { name, svg } of CARDS) {
    it(`the ${name} card draws brand-c.svg, not a letter in a circle`, () => {
      // A distinctive slice of the real path — enough that a re-drawn approximation fails.
      expect(svg).toContain(BRAND_MARK_PATH.slice(0, 60));
      // The old mark: a saffron disc with a Bodoni "C" set on top of it. Both must be gone —
      // "almost-right" is the failure mode the owner caught twice (pay page July, unfurl August).
      expect(svg).not.toMatch(/<circle cx="128" cy="118"/);
      expect(svg).not.toMatch(/text-anchor="middle">C<\/text>/);
    });

    it(`the ${name} card's wordmark clears the mark instead of overlapping it`, () => {
      const wordX = Number(svg.match(/<text x="(\d+)"[^>]*>CEYLON HOP</)![1]);
      expect(wordX).toBeGreaterThan(102 + markWidth(74));
    });
  }

  it('places the glyph where it is asked to, not where its 1024 box happens to sit', () => {
    // brand-c.svg's C occupies only part of its viewBox. Scaling the box would float the mark
    // with dead space around it, so the helper offsets by the glyph's own bounds.
    const g = brandMark(102, 80, 74, '#F9A429');
    const [, tx, ty] = g.match(/translate\((-?[\d.]+),(-?[\d.]+)\)/)!.map(Number);
    const scale = Number(g.match(/scale\(([\d.]+)\)/)![1]);
    expect(tx + 177.5 * scale).toBeCloseTo(102, 1); // glyph left edge
    expect(ty + 56 * scale).toBeCloseTo(80, 1); // glyph top edge
    expect(912.1 * scale).toBeCloseTo(74, 1); // glyph height
  });

  it('takes its colour from the card, not from the asset', () => {
    // The file carries an explicit saffron fill because the site loads it via <img>, where
    // currentColor cannot reach it. The group fill is what lets a card override that.
    expect(brandMark(0, 0, 10, '#123456')).toContain('fill="#123456"');
  });
});

describe('the two cards must not read as the same card', () => {
  const wash = (svg: string) => svg.match(/<linearGradient id="bg"[\s\S]*?<\/linearGradient>/)![0];

  it('the backgrounds differ — at thumbnail size that is the only tell', () => {
    expect(wash(payCardSvg(TRIP))).not.toBe(wash(quoteCardSvg(TRIP)));
  });

  it('pay runs WARM, quote runs COOL', () => {
    // Not merely "different": the direction is the point, and swapping them would pass a bare
    // inequality check while putting the payment card in the calmer colour.
    expect(wash(payCardSvg(TRIP))).toContain('#fdf7ec');
    expect(wash(quoteCardSvg(TRIP))).toContain('#f3f8f3');
    expect(payCardSvg(TRIP)).toMatch(/<radialGradient id="glow"[\s\S]*?#F9A429/);
    expect(quoteCardSvg(TRIP)).toMatch(/<radialGradient id="glow"[\s\S]*?#0AB9B6/);
  });

  it('holds for the generic cards too, which is what a dead link unfurls as', () => {
    expect(wash(payCardSvg(GENERIC_PAY_CARD))).not.toBe(wash(quoteCardSvg(GENERIC_QUOTE_CARD)));
  });
});

describe('the pay card says how you pay', () => {
  const pay = payCardSvg(TRIP);
  const quote = quoteCardSvg(TRIP);

  it('carries all three card marks', () => {
    expect(pay).toContain('VISA');
    expect(pay).toContain('AMEX');
    expect(pay).toContain('#EB001B'); // Mastercard red
    expect(pay).toContain('#F79E1B'); // Mastercard amber
    expect(pay).toContain('#FF5F00'); // the blended overlap — the mark's actual geometry
  });

  it('draws the Mastercard overlap by clipping, not by guessing at a third shape', () => {
    expect(pay).toContain('<clipPath id="mcLeft">');
    expect(pay).toMatch(/fill="#FF5F00" clip-path="url\(#mcLeft\)"/);
  });

  it('drops the domain, which the chat app already prints under the card', () => {
    expect(pay).not.toContain('pay.ceylonhop.com');
  });

  it('the QUOTE card carries none of it — nothing is being paid there', () => {
    expect(quote).not.toContain('VISA');
    expect(quote).not.toContain('AMEX');
    expect(quote).not.toContain('#EB001B');
  });

  it('still carries no amount — the marks say HOW you pay, never how much', () => {
    // The decision this whole feature turns on (owner, 2026-08-02): the card is public to
    // anyone the link reaches. Card marks are not a price, and must not become the excuse.
    expect(pay).not.toMatch(/\$\d/);
  });
});
