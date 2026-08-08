import type { RideListWithMembers } from '../db/rideListRepo';

/* ---------------------------------------------------------------------------
   The 1200x630 share card, composed as SVG and rasterised to PNG.

   SVG because it is text we can assert on in a test; PNG because chat apps
   will not render an SVG og:image. The card carries only what survives a chat
   thumbnail: route, date, the seats as a filling van, one per-seat price, and
   a fixed deadline (never a countdown — a cached preview would freeze it).
--------------------------------------------------------------------------- */

const C = {
  blue: '#63BFD6', teal: '#0AB9B6', tealDeep: '#08938f', saffron: '#F9A429', tomato: '#EC3A24',
  ink: '#3A3739', inkSoft: '#6c6a6b', cream: '#F0EEE5', paper: '#fffdf8', line: '#ded7c4',
} as const;

/* Font families for the rasterised cards, shared by shareCardImage / quoteCard / payCard.

   These are INTERNAL family names read out of the bundled TTFs, not file names or the
   CSS family. Resvg runs with loadSystemFonts:false, so a name that does not match a
   bundled face renders blank glyphs rather than falling back — and Google's static
   Bodoni Moda reports itself as "Bodoni Moda 11pt", so plain "Bodoni Moda" silently
   produces an empty card. Guarded by web-tests/unit/card-font-families.test.js. */
export const DISPLAY = 'Bodoni Moda 11pt';
export const BODY = 'Poppins';

/** Neither bundled face has '→', and resvg blanks a whole run over one missing glyph. */
export const deArrow = (s: string): string => s.replace(/\s*→\s*/g, ' – ');

const SEAT_COLOURS = ['#0AB9B6', '#63BFD6', '#F9A429', '#8f7ad6', '#4aa66a', '#d66a9c'];

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Greedy wrap. SVG has no auto-wrap, and the widths here are known and fixed. */
export function wrap(text: string, maxChars: number, maxLines = 2): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) { lines.push(line); line = w; } else { line = next; }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

const initials = (name: string): string => name.trim().slice(0, 2).toUpperCase();

export type CardModel = {
  from: string; to: string; when: string;
  taken: string[];           // first names, in join order
  capacity: number;
  lead: string; leadSub: string; hot: boolean;
  price: string; deadline: string; locked: boolean;
};

/** Everything the card says, derived once so the SVG stays presentation-only. */
export function cardModel(found: RideListWithMembers, parts: {
  lead: string; leadSub: string; hot: boolean; price: string; deadline: string; locked: boolean;
  when: string;
}): CardModel {
  const live = found.members
    .filter((m) => m.status === 'held' || m.status === 'charged')
    .sort((a, b) => a.position - b.position);
  // seats, not rows: one traveller can hold up to three, and the van fills by seats
  const taken: string[] = [];
  for (const m of live) for (let i = 0; i < (m.seats ?? 1); i++) taken.push(m.firstName);
  return {
    from: found.list.fromPlace, to: found.list.toPlace, when: parts.when,
    taken: taken.slice(0, found.list.capacity),
    capacity: found.list.capacity,
    lead: parts.lead, leadSub: parts.leadSub, hot: parts.hot,
    price: parts.price, deadline: parts.deadline, locked: parts.locked,
  };
}

export function cardSvg(m: CardModel): string {
  const STUB_X = 800;
  const open = Math.max(0, m.capacity - m.taken.length);

  // Route: from on one line, "→ to" beneath. Fixed shape means no text measuring,
  // and it reads as a ticket rather than a sentence.
  const longest = Math.max(m.from.length, m.to.length + 2);
  const routeSize = longest > 17 ? 50 : longest > 13 ? 58 : 64;

  const seats = Array.from({ length: m.capacity }, (_, i) => {
    const cx = 89 + i * 56;
    if (i < m.taken.length) {
      return `<circle cx="${cx}" cy="478" r="23" fill="${SEAT_COLOURS[i % SEAT_COLOURS.length]}"/>` +
        `<text x="${cx}" y="485" font-family="${BODY}" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">${xml(initials(m.taken[i]))}</text>`;
    }
    // the first open seat is the one on offer — ring it, that is the whole pitch
    const first = i === m.taken.length;
    return `<circle cx="${cx}" cy="478" r="22" fill="none" stroke="${first ? C.tomato : '#cbc3ad'}" stroke-width="${first ? 3 : 2.5}"${first ? '' : ' stroke-dasharray="6 5"'}/>` +
      `<text x="${cx}" y="487" font-family="${BODY}" font-size="26" font-weight="700" fill="${first ? C.tomato : '#a9a08a'}" text-anchor="middle">+</text>`;
  }).join('');

  const caption = open === 0
    ? `${m.capacity} of ${m.capacity} seats taken`
    : `${m.taken.length} of ${m.capacity} seats taken`;

  const leadLines = wrap(m.lead, 15, 2);
  const subLines = wrap(m.leadSub, 34, 3);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
    <stop offset="0" stop-color="#f3f8f3"/><stop offset="0.58" stop-color="#f7f4ea"/><stop offset="1" stop-color="#f2f6e9"/>
  </linearGradient>
  <radialGradient id="teal" cx="0.88" cy="-0.12" r="1.2">
    <stop offset="0" stop-color="${C.teal}" stop-opacity="0.2"/><stop offset="0.58" stop-color="${C.teal}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="warm" cx="-0.08" cy="1.08" r="0.9">
    <stop offset="0" stop-color="${C.saffron}" stop-opacity="0.22"/><stop offset="0.55" stop-color="${C.saffron}" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#teal)"/>
<rect width="1200" height="630" fill="url(#warm)"/>

<!-- ticket stub -->
<rect x="${STUB_X}" y="0" width="${1200 - STUB_X}" height="630" fill="${C.paper}"/>
<line x1="${STUB_X}" y1="0" x2="${STUB_X}" y2="630" stroke="#d9d3c0" stroke-width="2" stroke-dasharray="10 8"/>
<circle cx="${STUB_X}" cy="0" r="19" fill="${C.cream}"/>
<circle cx="${STUB_X}" cy="630" r="19" fill="${C.cream}"/>

<!-- brand -->
<circle cx="85" cy="70" r="19" fill="${C.saffron}"/>
<text x="85" y="79" font-family="${DISPLAY}" font-size="26" font-weight="800" fill="#fff" text-anchor="middle">C</text>
<text x="114" y="80" font-family="${DISPLAY}" font-size="27" font-weight="800" fill="${C.ink}">Ceylon Hop</text>

<!-- ride -->
<text x="66" y="250" font-family="${BODY}" font-size="14" font-weight="700" letter-spacing="2.8" fill="${C.tealDeep}">SHARED VAN · THE RIDE BOARD</text>
<text x="66" y="316" font-family="${DISPLAY}" font-size="${routeSize}" font-weight="800" fill="${C.ink}">${xml(m.from)}</text>
<!-- The arrow is DRAWN, not typed. No bundled face has '→' (Bodoni Moda and Poppins both
     lack it), and resvg has no system fonts to fall back to, so a literal arrow renders as
     .notdef. A path also keeps it optically aligned to the cap height at any routeSize. -->
<g transform="translate(66,${316 + routeSize + 8 - routeSize * 0.3})" stroke="${C.teal}" stroke-width="${routeSize * 0.09}" stroke-linecap="round" stroke-linejoin="round" fill="none">
  <path d="M0 0 h${routeSize * 0.52}"/><path d="M${routeSize * 0.34} ${-routeSize * 0.16} L${routeSize * 0.54} 0 L${routeSize * 0.34} ${routeSize * 0.16}"/>
</g>
<text x="${66 + routeSize * 0.76}" y="${316 + routeSize + 8}" font-family="${DISPLAY}" font-size="${routeSize}" font-weight="800" fill="${C.ink}">${xml(m.to)}</text>
<text x="66" y="${316 + routeSize + 52}" font-family="${BODY}" font-size="21" font-weight="700" fill="${C.inkSoft}">${xml(m.when)}</text>

<!-- seats -->
${seats}
<text x="66" y="540" font-family="${BODY}" font-size="20" font-weight="700" fill="${C.ink}">${xml(caption)}${open > 0 ? `<tspan dx="8" fill="${C.inkSoft}" font-weight="600">· ${open} still open</tspan>` : ''}</text>

<!-- deadline -->
<circle cx="76" cy="580" r="10" fill="none" stroke="${m.locked ? C.tealDeep : C.tomato}" stroke-width="2.4"/>
<path d="M76 574 L76 580 L80 583" fill="none" stroke="${m.locked ? C.tealDeep : C.tomato}" stroke-width="2.4" stroke-linecap="round"/>
<text x="95" y="588" font-family="${BODY}" font-size="20" font-weight="700" fill="${C.ink}">${xml(m.deadline)}</text>

<!-- stub content -->
${leadLines.map((l, i) => `<text x="842" y="${228 + i * 46}" font-family="${DISPLAY}" font-size="40" font-weight="800" fill="${m.hot ? C.tomato : C.tealDeep}">${xml(l)}</text>`).join('\n')}
${subLines.map((l, i) => `<text x="842" y="${228 + leadLines.length * 46 + 14 + i * 26}" font-family="${BODY}" font-size="18" font-weight="700" fill="${C.inkSoft}">${xml(l)}</text>`).join('\n')}
<line x1="842" y1="410" x2="1158" y2="410" stroke="${C.line}" stroke-width="1.5" stroke-dasharray="6 5"/>
<text x="842" y="444" font-family="${BODY}" font-size="14" font-weight="700" letter-spacing="2.2" fill="${C.inkSoft}">YOUR SEAT</text>
<text x="842" y="500" font-family="${DISPLAY}" font-size="54" font-weight="800" fill="${C.ink}">${xml(m.price)}<tspan dx="12" font-family="${BODY}" font-size="22" font-weight="700" fill="${C.inkSoft}">each</tspan></text>
<line x1="842" y1="528" x2="1158" y2="528" stroke="${C.line}" stroke-width="1.5" stroke-dasharray="6 5"/>
${m.locked
    ? `<text x="842" y="568" font-family="${BODY}" font-size="19" font-weight="700" fill="${C.tealDeep}">Charged · van locked in</text>`
    : `<text x="842" y="568" font-family="${BODY}" font-size="21" font-weight="700" fill="${C.tealDeep}">$0 to join</text>
<text x="842" y="594" font-family="${BODY}" font-size="16" font-weight="700" fill="${C.inkSoft}">pay only if it fills</text>`}
${m.locked
    ? `<g transform="rotate(38 1120 60)"><rect x="960" y="38" width="320" height="40" fill="${C.saffron}"/><text x="1120" y="65" font-family="${BODY}" font-size="17" font-weight="700" letter-spacing="2.4" fill="#fff" text-anchor="middle">IT'S ON!</text></g>`
    : ''}
</svg>`;
}
