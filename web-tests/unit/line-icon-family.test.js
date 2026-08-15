import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');
const LINE_DIR = 'img/icons/line';

/** Every inline `<svg>…</svg>` in a file, tag included. */
const inlineSvgs = src => [...src.matchAll(/<svg[\s\S]*?<\/svg>/g)].map(([m]) => m);
const wpCount = svg => (svg.match(/class="wp"/g) || []).length;

describe('line-icon family rule', () => {
  const files = readdirSync(join(ROOT, LINE_DIR)).filter(f => f.endsWith('.svg'));

  it('the library is not empty', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // The set's one hard rule (img/icons/line/README.md): exactly one filled waypoint dot per
  // icon. It is what makes a mark recognisable at 16px. An icon drawn without it — or with
  // two — is not in the family, however good it looks on its own.
  for (const f of files) {
    it(`${f}: carries exactly one waypoint dot`, () => {
      expect(wpCount(read(join(LINE_DIR, f)))).toBe(1);
    });
  }
});

// A mark inlined into a page inherits nothing: `fill="none"` on the <svg> root leaves the
// waypoint dot an invisible hairline ring unless the host page fills it from CSS. So an
// inlined `class="wp"` and a `.wp{fill:…}` rule are a matched pair — one without the other
// is a silently broken icon, which is exactly the failure a screenshot review misses.
describe('inlined marks are filled by their host page', () => {
  // Named slot by named slot, because "the page has *a* .wp rule somewhere" is not a guard:
  // delete the rule covering the service chooser and the page still has six others, so the
  // test passes while two icons render a hollow dot. Each selector below is the one that
  // fills a specific slot; if you rename a class, this list moves with it.
  const HOSTS = [
    {
      page: 'booking.html',
      inlinedBy: ['booking.html', 'booking.js'],
      selectors: [
        ['.svc-ico svg .wp', 'svc-ico'],                      // service chooser, both cards
        ['.loc-input-ic .wp', 'loc-input-ic'],                // pick-up / drop-off fields
        ['.flex-banner svg .wp', 'flex-banner'],              // "not sure of your timings yet"
        ['.pay-methods .pm svg .wp', 'pay-methods'],          // card · via PayHere
        ['.ac-item .ac-ic svg .wp', 'ac-ic'],                 // autocomplete suggestions
        ['.concierge svg .wp', 'concierge'],                  // both concierge notes
        ['.trip-route .tr-chip svg .wp', 'tr-chip'],          // per-leg date chip
        ['.s-perks svg .wp', 's-perks'],                      // the three summary perks
      ],
    },
    {
      page: 'plan.html',
      inlinedBy: ['plan.html'],
      selectors: [['.rail-empty svg .wp', 'rail-empty']],
    },
    // datepicker.js injects its button into every page that loads it, and the fill rule for
    // it lives in the shared site.css rather than any one page.
    {
      page: 'site.css',
      inlinedBy: ['datepicker.js'],
      selectors: [['.dp-btn svg .wp', 'dp-btn']],
    },
    // The results page draws its marks from two files: the option cards are built in
    // search.js, the reassurance row is static in search.html. Both are listed so the
    // "two waypoint dots" guard covers each.
    {
      page: 'search.html',
      inlinedBy: ['search.js', 'search.html'],
      selectors: [
        ['.route-meta svg .wp', 'route-meta'],
        // The two card headers sit on filled discs — teal for private, saffron for shared —
        // so each needs its own fill, and the shared one cannot be saffron-on-saffron.
        ['.opt-private .o-ico svg .wp', 'o-ico'],
        ['.opt-shared .o-ico svg .wp', 'o-ico'],
        ['.veh-row .v-ico svg .wp', 'v-ico'],
        ['.incl .chip svg .wp', 'chip'],
        ['.noshare .ns-ico svg .wp', 'ns-ico'],
        ['.shared-meta .sm svg .wp', 'sm'],
        ['.reassure svg .wp', 'reassure'],
      ],
    },
  ];

  for (const { page, inlinedBy, selectors } of HOSTS) {
    const css = () => read(page);
    const markup = () => inlinedBy.map(read).join('\n');

    it(`${page}: inlines at least one family mark`, () => {
      const marked = inlinedBy.flatMap(f => inlineSvgs(read(f)).filter(svg => wpCount(svg) > 0));
      expect(marked.length).toBeGreaterThan(0);
    });

    for (const [selector, cls] of selectors) {
      it(`${page}: fills the waypoint dot in ${cls}`, () => {
        const rule = css().match(
          new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{}]*\\{[^}]*\\}`)
        );
        expect(rule, `no CSS rule fills ${selector}`).not.toBeNull();
        expect(rule[0]).toMatch(/fill:/);
      });

      // A selector that no longer matches anything is the same broken icon, one step earlier.
      it(`${page}: the ${cls} slot still exists in the markup`, () => {
        expect(markup()).toContain(cls);
      });
    }

    for (const f of inlinedBy) {
      it(`${f}: no inlined mark carries two waypoint dots`, () => {
        expect(inlineSvgs(read(f)).filter(svg => wpCount(svg) > 1)).toEqual([]);
      });
    }
  }
});

// The quiet way one of these regresses: the markup is correct in the HTML, and a script
// replaces the whole row a moment later with an older mark. Changing the page without
// changing the rewrite looks right in the diff and wrong in the browser.
describe('runtime rewrites keep the mark they replace', () => {
  const REWRITES = [
    { file: 'booking.js', target: 'perk-cancel', why: 'rewritten with the live cancellation text' },
  ];

  for (const { file, target, why } of REWRITES) {
    it(`${file}: the ${target} rewrite (${why}) still carries a waypoint dot`, () => {
      const src = read(file);
      // the innerHTML assignment for this element, up to the closing </svg>
      const assign = src.match(
        new RegExp(`${target}[\\s\\S]{0,400}?innerHTML\\s*=\\s*\`[\\s\\S]*?<\\/svg>`)
      );
      expect(assign, `no innerHTML rewrite found for ${target}`).not.toBeNull();
      expect(assign[0]).toContain('class="wp"');
    });
  }
});
