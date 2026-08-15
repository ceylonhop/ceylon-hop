import { wrap, DISPLAY, BODY, deArrow, brandMark, markWidth } from './shareCardImage';
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
  ink: '#3A3739', inkSoft: '#6c6a6b', paper: '#fffdf8', line: '#ded7c4',
} as const;

/* THE WARM WASH IS THE TELL (owner, 2026-08-10): "the unfurl looks exactly the same for quote
   and pay, there needs to be a tiny dif so people don't confuse the two."
   Both cards carry the same trip in the same layout, so at chat-thumbnail size the only thing
   that separates them before a word is read is the background. The quote card keeps the cool
   green-cream both started with; this one goes amber, which is also where the red PayHere
   button it leads to lives. Deliberately a wash and not a badge — the layout the owner already
   signed off on is untouched. quoteCardIsCool in the tests pins the two apart. */
const WASH = { top: '#fdf7ec', mid: '#fbf1e0', bottom: '#fdf4e4' } as const;

/* Card marks, drawn rather than typed (owner, 2026-08-10: "the unfurl does not show the actual
   logos"). Mastercard is real geometry — two interlocking circles with the blended overlap — so
   it is the genuine mark. Visa and American Express are trademarked LETTERFORMS, which cannot be
   reproduced faithfully from paths written by hand; they are set in the bundled body face and
   read as the wordmark at the size a chat app draws this. Same compromise pay.html already makes
   on the page itself, where the badges under the button are type too. */
const BRANDS = { visa: '#1434CB', mcRed: '#EB001B', mcAmber: '#F79E1B', mcBlend: '#FF5F00', amex: '#006FCF' } as const;

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
  // '→' has no glyph in EITHER bundled face, and resvg blanks the whole run over one
  // missing glyph. Under the old Newsreader/Hanken pairing only the serif lacked it, so
  // guarding the route line sufficed; Poppins lacks it too, so every rasterised string goes
  // through deArrow now. Swapped HERE, in the renderer with the font limitation: the model
  // keeps the arrow, and so does the OG description, which WhatsApp draws with its own fonts.
  const routeLines = wrap(deArrow(m.route), 30, 2);
  const detailLines = wrap(deArrow(m.detail), 44, 2);
  const routeY = 300;
  // Resvg runs with loadSystemFonts:false, so ONLY the bundled faces resolve, and they must
  // be named by their INTERNAL family string — see DISPLAY/BODY in shareCardImage.ts.
  const text = (t: string, y: number, size: number, family: typeof DISPLAY | typeof BODY, weight: number, fill: string) =>
    `<text x="100" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}">${xml(t)}</text>`;

  // The mark is 74 tall; the wordmark beside it starts one comfortable gap past its right edge,
  // computed rather than hardcoded so a change of height cannot leave the two overlapping.
  const MARK_X = 102;
  const MARK_H = 74;
  const wordX = Math.round(MARK_X + markWidth(MARK_H) + 22);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
    <stop offset="0" stop-color="${WASH.top}"/><stop offset="0.58" stop-color="${WASH.mid}"/><stop offset="1" stop-color="${WASH.bottom}"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.9" cy="-0.1" r="1.1">
    <stop offset="0" stop-color="${C.saffron}" stop-opacity="0.22"/><stop offset="1" stop-color="${C.saffron}" stop-opacity="0"/>
  </radialGradient>
  <!-- The blended wedge of the Mastercard mark: the amber disc, clipped to the red one. -->
  <clipPath id="mcLeft"><circle cx="17" cy="17" r="17"/></clipPath>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#glow)"/>

${brandMark(MARK_X, 80, MARK_H, C.saffron)}
<text x="${wordX}" y="131" font-family="${DISPLAY}" font-size="30" font-weight="800" fill="${C.tealDeep}" letter-spacing="1.5">CEYLON HOP</text>

${text(m.lead, 216, 40, BODY, 700, C.inkSoft)}
${routeLines.map((l, i) => text(l, routeY + i * 62, 56, DISPLAY, 800, C.ink)).join('\n')}
${detailLines.map((l, i) => text(l, routeY + routeLines.length * 62 + 14 + i * 40, 30, BODY, 700, C.inkSoft)).join('\n')}

<line x1="100" y1="516" x2="1100" y2="516" stroke="${C.line}" stroke-width="2"/>
<g transform="translate(100,545)">
  <rect x="0" y="6" width="20" height="15" rx="3" fill="${C.tealDeep}"/>
  <path d="M4 6 v-4 a6 6 0 0 1 12 0 v4" fill="none" stroke="${C.tealDeep}" stroke-width="3"/>
</g>
<text x="134" y="566" font-family="${BODY}" font-size="26" font-weight="700" fill="${C.inkSoft}">Secure payment · PayHere</text>
<!-- The card marks take the right end of the footer, where the domain used to sit. The domain
     is not lost: WhatsApp prints it under the card itself, so it was the one thing here that
     was already being said twice. -->
<g transform="translate(882,539)">
  <text x="0" y="26" font-family="${BODY}" font-size="26" font-weight="700" fill="${BRANDS.visa}" letter-spacing="1">VISA</text>
  <g transform="translate(84,0)">
    <circle cx="17" cy="17" r="17" fill="${BRANDS.mcRed}"/>
    <circle cx="39" cy="17" r="17" fill="${BRANDS.mcAmber}"/>
    <circle cx="39" cy="17" r="17" fill="${BRANDS.mcBlend}" clip-path="url(#mcLeft)"/>
  </g>
  <g transform="translate(156,0)">
    <rect width="62" height="34" rx="6" fill="${BRANDS.amex}"/>
    <text x="31" y="23" font-family="${BODY}" font-size="15" font-weight="700" fill="${C.paper}" text-anchor="middle" letter-spacing="0.6">AMEX</text>
  </g>
</g>
</svg>`;
}

/** OG/Twitter text. Mirrors the card, and likewise never carries the amount. */
export function payCardMeta(m: PayCardModel): { title: string; description: string } {
  return {
    title: `${m.lead} · Ceylon Hop`,
    description: m.detail ? `${m.route} · ${m.detail}` : m.route,
  };
}
