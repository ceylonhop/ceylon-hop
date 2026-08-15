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

/* The Ceylon Hop mark, as the path out of img/brand-c.svg — the same file site.js's cmark()
   serves the site header with. Inlined rather than read at runtime: these renderers are pure
   functions with no fs, and the API image is not guaranteed to ship the site root. Kept honest
   by web-tests/unit/card-brand-mark.test.js, which fails the moment the two diverge.

   The cards used to draw a saffron circle with a Bodoni letter C in it. That is the SAME mistake
   the pay PAGE made and had corrected (see customerPages.test.ts, "uses the REAL logo file, not
   a hand-drawn C"): it reads as almost-right, which is worse than obviously wrong. The owner
   caught it on the page in July 2026 and on the unfurl in August. */
export const BRAND_MARK_PATH = 'M540 56.6C539.2 56.7 532.7 57.6 525.5 58.5C502.4 61.3 475.1 68.1 455.3 75.9C452.4 77.1 447.9 78.8 445.3 79.8C439.4 82.1 419.3 92 412.5 96C409.8 97.6 406.8 99.2 406 99.6C398.5 103.2 369.6 124.1 356.5 135.4C334.3 154.7 301.6 191.6 284 217.6C274.2 232 268.4 240.7 267.7 242C267.3 242.8 265.7 245.5 264 248C261.6 251.8 252.5 267.4 246.8 277.5C242.9 284.6 229.7 311.8 226 320.5C224.8 323.3 220.2 334.6 218 340C217 342.5 215.2 346.8 214.1 349.7C212.9 352.5 212 355.5 212 356.2C212 356.9 211.4 358.6 210.7 360C210 361.4 208.1 366.5 206.6 371.5C205.1 376.4 203.4 381.8 202.8 383.5C199 394.7 191.1 427.2 188.4 442.5C187.6 447.4 186.5 453.1 186 455C185.5 456.9 184.6 462.8 184 468C183.4 473.2 182.5 479.7 182 482.5C177.5 506.9 177.5 587.4 182 615.5C182.6 618.8 183.7 626.2 184.5 632C188.8 662.1 199.2 703.7 206.6 719.7C207.3 721.4 208 723.4 208 724.2C208 724.9 208.6 726.4 209.4 727.5C210.1 728.6 211.1 730.6 211.5 732C212.4 735 220.6 752 225.2 760.5C239.7 787.1 260.1 815.6 288.9 849.5C311 875.6 343.4 903.4 368.5 918C372.4 920.3 377.3 923.2 379.5 924.5C383.5 926.9 399.2 934.7 406.5 938C408.7 938.9 412.1 940.4 414 941.3C423.6 945.6 454 956 457 956C457.8 956 461.4 956.9 465 957.9C473.1 960.3 486.3 963 495.5 964.1C499.4 964.5 507.7 965.6 514 966.4C521.1 967.4 533.1 968 545.5 968C594.5 968.1 641.4 957.3 685 936C691.9 932.7 702.5 926.7 704.1 925.4C704.9 924.6 705.9 924 706.2 924C706.6 924 710.3 921.6 714.5 918.7C718.7 915.9 723.2 912.8 724.4 912C728.5 909.3 740.8 899 748.9 891.5C764.1 877.5 779 859.6 793.1 838.5C797.8 831.4 799.8 828 805.3 818C806.9 815 808.8 811.6 809.5 810.5C810.1 809.4 813 803.1 815.9 796.5C818.8 789.9 821.5 783.6 822 782.5C823.3 779.7 825.9 772.3 827.5 767C828.3 764.5 829.6 760.5 830.4 758C834.8 744.6 837.2 734.2 839.6 717C840.4 711.2 841.5 704.2 842.1 701.5C844.8 687.1 844.8 632.4 842.1 623.5C841.5 621.8 840.8 618.2 840.4 615.5C840 612.7 838.7 607.3 837.4 603.5C829.9 580.8 817.3 568 802.5 568C793.9 568 789.5 569.5 784.5 574.4C780.2 578.4 780 578.9 780 584.3C780 587.4 780.4 590.1 780.9 590.5C783.4 592 792 610.7 792 614.7C792 615.8 792.8 618.7 793.7 621.1C796.1 627.5 796.2 673.3 793.8 683.5C792.9 687.3 791.7 692.7 791.1 695.5C787.3 713 779.3 732.3 769.5 747.5C751 776.2 722.2 800.1 689.5 814.1C685.7 815.8 681.6 817.5 680.5 818C670.1 822.8 646.7 829 630 831.5C624.8 832.3 617.5 833.4 613.7 834C605 835.3 570.1 835.3 561.3 834C557.5 833.4 550 832.3 544.5 831.5C517.4 827.5 489.8 818.7 467 806.7C454.8 800.3 454.4 800.1 444.5 793.5C419.6 777.1 400.1 756.6 382.5 728.5C379.8 724.3 373.2 711.2 371.5 707C364.5 688.7 361.9 679.3 358.5 659.2C356.4 647.1 356 641.6 356 623.8C356 612.2 356.4 599.9 356.9 596.6C357.5 593.2 358.4 586.9 359 582.5C361.4 565.8 366.3 547.2 371.8 533.5C377.3 519.8 378.4 516.9 380.5 508.9C383 499.7 383.4 494.5 383.1 472.4C382.9 455.8 383.3 452 386.7 442C391.8 426.8 399.8 414.9 412.4 403.6L420 396.8L420 383.7C420 363.1 424.4 350 435.1 338.5C442.4 330.7 450.1 326.7 458.7 326.2C466.9 325.6 467.4 326.8 462.9 336.3C459.1 344.3 450.3 360.2 445.5 367.5C443.4 370.8 429 388.9 426.7 391.2C424.6 393.3 422 398.6 422 400.9C422 405 417.9 411.8 410.1 420.8C396.4 436.5 392.3 448.2 398.9 452.9C402.6 455.6 407.9 455.6 412.5 452.9C416.7 450.4 418.7 447 420 440.1C421.1 434 428.5 422 451.1 389C457.1 380.2 469.2 364.6 477.1 355.5C491.2 339.1 501.6 330.8 535 308.7C553.9 296.2 562.7 289.5 571 281.1C580.1 271.9 583.9 265.2 584.7 256.6C585.7 245.9 584.4 239.7 580 234.2C576.7 230 574.7 228.6 564.4 224C534.8 210.7 525.8 205.6 517.7 197.5C515 194.7 512.3 190.6 511.2 187.7C509.4 183 509.4 182.4 510.9 177.6C512.1 173.7 514.2 170.8 519.5 165.4C527.7 157.1 535.3 152.8 545.5 150.9C554.7 149.2 610 148.5 623 149.9C628.2 150.5 638.4 151.4 645.5 152C652.7 152.6 660.5 153.5 663 154C665.5 154.5 671.8 155.6 677 156.4C696.5 159.5 720.2 165.5 730.5 169.9C739.9 174 751.5 179.8 756 182.8C764 188 774.1 198.6 777.5 205.4C780.3 211 780.5 212 780.4 222.9C780.4 235.4 780.2 236 771.5 254.5C765.7 266.9 764.2 271.4 763.6 278.5C762.3 291.5 765.4 299.6 773.8 305.4C777.1 307.7 778.6 308 785.3 308C791.7 308 794 307.5 797.8 305.5C807.5 300.4 815.6 289.6 820.5 275.2C825.2 261.6 827.5 243.2 826 231.7C824.1 216.6 822.8 209.8 821.4 207.2C820.6 205.7 820 203.7 820 202.8C820 200.3 811.3 182.4 807.2 176.5C793.7 157 761.3 127.1 733.5 108.5C720.4 99.7 700 88.4 686.5 82.5C684.9 81.8 680.9 80 677.6 78.6C674.4 77.2 671.3 76 670.8 76C670.2 76 668.4 75.3 666.7 74.6C656.5 69.9 627.4 62.3 611 60C585.5 56.4 580.3 56 561.5 56.1C550.5 56.2 540.8 56.4 540 56.6Z';

/* Glyph bounds inside brand-c.svg's 1024 box. The drawn C does not fill that box, so scaling
   the raw viewBox would leave the mark floating with dead space on every side. */
const MARK = { x: 177.5, y: 56, w: 667.3, h: 912.1 } as const;

/**
 * The mark, drawn `height` tall with its visual top-left corner at (x, y).
 *
 * `fill` is passed on the group because the source file carries an explicit saffron fill (it is
 * loaded via <img> on the site, where currentColor cannot reach it). Setting it here keeps each
 * card's own palette the source of truth rather than the asset.
 */
export function brandMark(x: number, y: number, height: number, fill: string): string {
  const s = height / MARK.h;
  const tx = (x - MARK.x * s).toFixed(2);
  const ty = (y - MARK.y * s).toFixed(2);
  return `<g transform="translate(${tx},${ty}) scale(${s.toFixed(5)})" fill="${fill}"><path d="${BRAND_MARK_PATH}"/></g>`;
}

/** Drawn width of the mark at a given height — for laying out whatever sits beside it. */
export const markWidth = (height: number): number => (height / MARK.h) * MARK.w;

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
