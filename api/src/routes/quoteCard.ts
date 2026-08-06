import { wrap } from './shareCardImage';
import { payPageCopy } from '../quote/payPageCopy';
import type { SavedQuote } from '../db/quoteRepo';

// The WhatsApp/OG card for a customer QUOTE link (spec 2026-08-05 D11).
//
// Sibling of payCard.ts, and it exists for the same reason: the crawler does not run JavaScript
// and quote.html renders everything from a fetch after load, so without server-rendered tags the
// link unfurls as a bare URL with a base64 token in it. On a pay link that reads like phishing;
// on a quote link it is the FIRST thing the customer ever sees of a trip we spent real time
// planning, which is a poor way to open.
//
// TWO RULES, and they pull in the same direction:
//
//   1. NO PRICE ON THE CARD. WhatsApp fetches a preview once and caches it against the URL for
//      days. This link deliberately FOLLOWS its quote (D3) and ops re-pastes the same URL after
//      an edit (D4) — so a price baked into the card would keep showing the old number under a
//      page showing the new one. The same reasoning already keeps countdowns off the ride card.
//   2. The card is PUBLIC to anyone the link reaches — group chats, lock screens, forwards. It
//      carries the trip, never the customer's contact details, and never the amount.
//
// The trip is also what makes the link credible: no phisher knows the customer's route.

const C = {
  teal: '#0AB9B6', tealDeep: '#08938f', saffron: '#F9A429',
  ink: '#2C2A2B', inkSoft: '#6c6a6b', paper: '#fffdf8', line: '#ded7c4',
} as const;

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface QuoteCardModel {
  /** Headline. Generic for every state that is not a live quote. */
  lead: string;
  /** The route line — the part a phisher could not know. Empty on the generic card. */
  route: string;
  /** "20–28 August · Private car · 2 travellers". Empty on the generic card. */
  detail: string;
}

/**
 * The one card every non-live state renders: no customer data of any kind.
 *
 * Deliberately identical for "bad token", "withdrawn" and "expired" alike, so a crawler cannot
 * diff previews to learn which quote ids exist — the same soft-failure contract /quote-view
 * answers with.
 */
export const GENERIC_QUOTE_CARD: QuoteCardModel = {
  lead: 'Your Sri Lanka trip',
  route: 'A trip planned by Ceylon Hop',
  detail: '',
};

/**
 * Build the card from a live quote. NEVER reads totalCents — see rule 1 above;
 * `quoteCardHasNoAmount` in the tests is the guard on that.
 */
export function quoteCardModel(quote: SavedQuote): QuoteCardModel {
  const copy = payPageCopy(quote);
  const name = (quote.customerName ?? '').trim().split(/\s+/)[0];
  return {
    // The greeting is what makes it read as a document written FOR them rather than a broadcast.
    lead: name ? `${name}, your trip is ready` : 'Your trip is ready',
    // `title` is the route for single/multi ("Colombo Airport → Ella") and the shape line for
    // chauffeur ("Nine days across Sri Lanka"); `subtitle` carries dates + vehicle + travellers.
    route: copy.title,
    detail: copy.subtitle,
  };
}

export function quoteCardSvg(m: QuoteCardModel): string {
  // '→' has no glyph in Newsreader-ExtraBold, and resvg falls the WHOLE text run back to Hanken
  // Grotesk when one glyph is missing — so a routed title would silently render in sans while
  // the generic card rendered in the brand serif. Swap it for an en dash HERE, in the renderer
  // with the font limitation: the model keeps the arrow, and so does the OG description, which
  // WhatsApp draws with its own fonts.
  const routeLines = wrap(m.route.replace(/\s*→\s*/g, ' – '), 30, 2);
  const detailLines = wrap(m.detail, 44, 2);
  const routeY = 300;
  // Resvg runs with loadSystemFonts:false, so ONLY the bundled faces resolve: Newsreader-ExtraBold
  // and HankenGrotesk Bold/SemiBold. Naming anything else renders blank glyphs.
  const text = (t: string, y: number, size: number, family: 'Newsreader' | 'Hanken Grotesk', weight: number, fill: string) =>
    `<text x="100" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}">${xml(t)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
    <stop offset="0" stop-color="#f3f8f3"/><stop offset="0.58" stop-color="#f7f4ea"/><stop offset="1" stop-color="#f2f6e9"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.9" cy="-0.1" r="1.1">
    <stop offset="0" stop-color="${C.teal}" stop-opacity="0.20"/><stop offset="1" stop-color="${C.teal}" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#glow)"/>

<circle cx="128" cy="118" r="30" fill="${C.saffron}"/>
<text x="128" y="131" font-family="Newsreader" font-size="34" font-weight="800" fill="${C.paper}" text-anchor="middle">C</text>
<text x="176" y="131" font-family="Newsreader" font-size="30" font-weight="800" fill="${C.tealDeep}" letter-spacing="1.5">CEYLON HOP</text>

${text(m.lead, 216, 40, 'Hanken Grotesk', 600, C.inkSoft)}
${routeLines.map((l, i) => text(l, routeY + i * 62, 56, 'Newsreader', 800, C.ink)).join('\n')}
${detailLines.map((l, i) => text(l, routeY + routeLines.length * 62 + 14 + i * 40, 30, 'Hanken Grotesk', 600, C.inkSoft)).join('\n')}

<line x1="100" y1="516" x2="1100" y2="516" stroke="${C.line}" stroke-width="2"/>
<g transform="translate(100,544)" fill="none" stroke="${C.tealDeep}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 4 h18 a3 3 0 0 1 3 3 v14 a3 3 0 0 1 -3 3 h-18 a3 3 0 0 1 -3 -3 v-14 a3 3 0 0 1 3 -3 z"/>
  <path d="M6 11 h14 M6 17 h9"/>
</g>
<text x="140" y="566" font-family="Hanken Grotesk" font-size="26" font-weight="600" fill="${C.inkSoft}">Your quote · day by day, with prices</text>
<text x="1100" y="566" font-family="Hanken Grotesk" font-size="26" font-weight="600" fill="${C.tealDeep}" text-anchor="end">ceylonhop.com</text>
</svg>`;
}

/** OG/Twitter text. Mirrors the card, and likewise never carries the amount. */
export function quoteCardMeta(m: QuoteCardModel): { title: string; description: string } {
  return {
    title: `${m.lead} · Ceylon Hop`,
    description: m.detail ? `${m.route} · ${m.detail}` : m.route,
  };
}
