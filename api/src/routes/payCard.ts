import { wrap } from './shareCardImage';
import { payPageCopy } from '../quote/payPageCopy';
import type { SavedQuote } from '../db/quoteRepo';

// The WhatsApp/OG card for a quote PAY link (spec 2026-08-02).
//
// Why this exists: ops sends pay links over WhatsApp, and pay.html carried no og: tags at all —
// so the message unfurled as a bare 200-character URL with a base64 token in it, immediately
// before asking for several hundred dollars. That is the visual grammar of a phishing link at
// the exact moment the customer most needs to trust it.
//
// The card cannot be built client-side: WhatsApp's crawler does not run JavaScript, and
// pay.html renders everything from a fetch after load. Hence server-rendered, per token.
//
// OWNER DECISION (2026-08-02): the TRIP goes on the card, the AMOUNT does not. The itinerary is
// what proves the link is genuinely from Ceylon Hop — no phisher knows the customer's route —
// while the price stays one tap away on a page that is already bearer-authenticated. This card
// is public to anyone the link reaches: group chats, lock screens, forwards.

const C = {
  teal: '#0AB9B6', tealDeep: '#08938f', saffron: '#F9A429',
  ink: '#2C2A2B', inkSoft: '#6c6a6b', paper: '#fffdf8', line: '#ded7c4',
} as const;

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface PayCardModel {
  /** Headline. Generic for every non-payable state. */
  lead: string;
  /** The route line — the part a phisher could not know. Empty on the generic card. */
  route: string;
  /** "16–21 August · Private car · 2 guests". Empty on the generic card. */
  detail: string;
}

/** The one card every non-payable state renders: no customer data of any kind. */
export const GENERIC_PAY_CARD: PayCardModel = {
  lead: 'Secure payment',
  route: 'Confirm your Sri Lanka trip',
  detail: '',
};

/**
 * Build the card from a payable quote. NEVER reads totalCents — see the owner decision above;
 * `payCardHasNoAmount` in the tests is the guard on that.
 */
export function payCardModel(quote: SavedQuote): PayCardModel {
  const copy = payPageCopy(quote);
  // `title` is the route for single/multi ("Colombo Airport (CMB) → Galle") and the shape line
  // for chauffeur ("Six days across Sri Lanka"); `subtitle` carries the dates + vehicle + pax.
  return {
    lead: 'Your trip is ready to confirm',
    route: copy.title,
    detail: copy.subtitle,
  };
}

export function payCardSvg(m: PayCardModel): string {
  // '→' has no glyph in Newsreader-ExtraBold, and resvg falls the WHOLE text run back to
  // Hanken Grotesk when a single glyph is missing — so a routed title silently rendered in
  // sans while the generic card rendered in the brand serif. Swap it for an en dash HERE, in
  // the renderer that has the font limitation: the model keeps the arrow, and so does the OG
  // description, which WhatsApp draws with its own fonts.
  const routeLines = wrap(m.route.replace(/\s*→\s*/g, ' – '), 30, 2);
  const detailLines = wrap(m.detail, 44, 2);
  const routeY = 300;
  // Resvg runs with loadSystemFonts:false, so ONLY the bundled faces resolve:
  // Newsreader-ExtraBold (the brand display) and HankenGrotesk Bold/SemiBold. Naming
  // anything else here renders blank glyphs — the ride card sticks to the same two.
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
<g transform="translate(100,545)">
  <rect x="0" y="6" width="20" height="15" rx="3" fill="${C.tealDeep}"/>
  <path d="M4 6 v-4 a6 6 0 0 1 12 0 v4" fill="none" stroke="${C.tealDeep}" stroke-width="3"/>
</g>
<text x="134" y="566" font-family="Hanken Grotesk" font-size="26" font-weight="600" fill="${C.inkSoft}">Secure payment · PayHere</text>
<text x="1100" y="566" font-family="Hanken Grotesk" font-size="26" font-weight="600" fill="${C.tealDeep}" text-anchor="end">pay.ceylonhop.com</text>
</svg>`;
}

/** OG/Twitter text. Mirrors the card, and likewise never carries the amount. */
export function payCardMeta(m: PayCardModel): { title: string; description: string } {
  return {
    title: `${m.lead} · Ceylon Hop`,
    description: m.detail ? `${m.route} · ${m.detail}` : m.route,
  };
}
