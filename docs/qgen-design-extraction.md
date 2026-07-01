# Ceylon Hop Ops · Quote Generator — Design Extraction Spec

> **Purpose:** This document is the complete implementation contract for rebuilding the Quote Generator UI pixel-faithfully. Every value, class name, and template string is copied verbatim from the source files in `/tmp/qgen-src/`. An engineer should be able to rebuild without access to the originals.
>
> **Source files consumed:**
> - `__template.json` — full HTML/CSS template (55 KB)
> - `a5b42bed-b71b-49cf-965b-85a8295f7bd0.js` — CH model namespace (pricing engine, generators)
> - `e2b09326-baed-428f-a638-091af5b1e896.js` — shared UI primitives (Card, Button, Field, etc.)
> - `7b1928a8-7f90-408e-83b1-060cae239a61.js` — CustomerCard + SettingsCard
> - `518dcb27-f0b3-49c1-9498-0fa9dbfd62d1.js` — ItineraryCard + LegCard + helper components
> - `33fa2776-5f75-45c6-80f6-1b523509d843.js` — SummaryCard, FlagsCard, OutputCard
> - `_app_inline.txt` — App root component + bottom CSS tail

---

## 1. Complete CSS

The full stylesheet is split into two `<style>` blocks in the HTML template. Block 1 (18 KB) is `@font-face` declarations only (Bodoni Moda weights 500–800, Poppins weights 400–700) — omitted here as it only references local woff2 asset UUIDs. Block 2 (27 KB) is reproduced verbatim below.

```css
/* Ceylon Hop Ops — base + layout + components CSS */
:root {
  --blue: #63BFD6;
  --blue-d: #3da6c0;
  --black: #3A3739;
  --cream: #F0EEE5;
  --cream-d: #e6e3d6;
  --orange: #F9A429;
  --red: #EC3A24;
  --teal: #0AB9B6;
  --teal-d: #089a97;

  --paper: #ffffff;
  --ink: #3A3739;
  --muted: #8b8780;
  --muted-2: #b4afa6;
  --line: #e7e3d8;
  --line-soft: #efece2;

  --r-lg: 18px;
  --r-md: 13px;
  --r-sm: 9px;
  --shadow-card: 0 1px 2px rgba(58,55,57,.04), 0 8px 24px rgba(58,55,57,.06);
  --shadow-pop: 0 12px 40px rgba(58,55,57,.16);
  --serif: "Bodoni Moda", "Didot", Georgia, serif;
  --sans: "Poppins", system-ui, sans-serif;
}

* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: var(--sans);
  color: var(--ink);
  background: var(--cream);
  background-image: radial-gradient(circle at 18% -8%, rgba(99,191,214,.10), transparent 42%),
                    radial-gradient(circle at 100% 0%, rgba(249,164,41,.07), transparent 38%);
  -webkit-font-smoothing: antialiased;
  font-size: 14px;
  line-height: 1.45;
}
h1, h2, h3 { margin: 0; font-weight: 600; }
input, select, textarea, button { font-family: inherit; }

/* ---------- App shell ---------- */
.ch-app { min-height: 100vh; padding-bottom: 64px; }
.ch-container { max-width: 1340px; margin: 0 auto; padding: 0 22px; }

/* ---------- Header ---------- */
.ch-header {
  position: sticky; top: 0; z-index: 50;
  background: rgba(255,255,255,.82);
  backdrop-filter: saturate(1.4) blur(12px);
  border-bottom: 1px solid var(--line);
}
.ch-header-in { max-width: 1340px; margin: 0 auto; padding: 12px 22px; display: flex; align-items: center; gap: 18px; }
.ch-brand { display: flex; align-items: center; gap: 11px; }
.ch-mark {
  width: 38px; height: 38px; border-radius: 50%;
  background: var(--blue); color: #fff;
  display: grid; place-items: center;
  font-family: var(--serif); font-weight: 700; font-size: 18px;
  box-shadow: 0 3px 0 var(--blue-d);
}
.ch-brand-txt { line-height: 1.05; }
.ch-brand-txt b { font-family: var(--serif); font-size: 19px; font-weight: 700; letter-spacing: .2px; display: block; }
.ch-brand-txt span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 2.2px; color: var(--muted); }
.ch-header-spacer { flex: 1; }
.ch-header-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

/* ---------- Status select ---------- */
.ch-status {
  display: inline-flex; align-items: center; gap: 7px;
  border-radius: 999px; padding: 5px 6px 5px 12px;
  border: 1px solid var(--line); background: #fff;
  font-size: 12.5px; font-weight: 500;
}
.ch-status .dot { width: 9px; height: 9px; border-radius: 50%; }
.ch-status select { border: none; background: none; font-weight: 600; font-size: 12.5px; outline: none; cursor: pointer; color: var(--ink); }

/* ---------- Layout grid ---------- */
.ch-main { padding-top: 22px; display: grid; grid-template-columns: minmax(0, 1.62fr) minmax(320px, .92fr); gap: 20px; align-items: start; }
.ch-col-l { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.ch-col-r { display: flex; flex-direction: column; gap: 20px; position: sticky; top: 86px; }
.ch-output-wrap { margin-top: 20px; }
@media (max-width: 1080px) {
  .ch-main { grid-template-columns: 1fr; }
  .ch-col-r { position: static; }
}

/* ---------- Card ---------- */
.ch-card { background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-card); overflow: hidden; }
.ch-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--line-soft); }
.ch-card-head-l { display: flex; align-items: center; gap: 11px; }
.ch-card-head h2 { font-family: var(--serif); font-size: 19px; font-weight: 700; letter-spacing: .2px; white-space: nowrap; }
.ch-card-head-l { min-width: 0; }
.ch-card-icon { width: 26px; height: 26px; border-radius: 8px; background: var(--black); color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 600; opacity: .92; }
.ch-card-head-r { display: flex; align-items: center; gap: 10px; }
.ch-chev { font-size: 19px; color: var(--muted); transition: transform .2s; line-height: 1; }
.ch-chev.open { transform: rotate(180deg); }
.ch-card-body { padding: 18px; }
.ch-card-body.nopad { padding: 0; }
.ch-head-tools { display: flex; align-items: center; gap: 8px; }

/* ---------- Fields ---------- */
.ch-row { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.ch-row:last-child { margin-bottom: 0; }
.ch-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 0; }
.ch-field-label { font-size: 11.5px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .6px; display: flex; align-items: center; gap: 3px; }
.ch-field-label .req { color: var(--red); font-style: normal; }
.ch-field-hint { font-size: 11px; color: var(--red); }
.ch-card-body > .ch-field { margin-top: 14px; }

.ch-input-wrap { display: flex; align-items: center; gap: 0; background: #fff; border: 1.5px solid var(--line); border-radius: var(--r-sm); padding: 0 10px; transition: border-color .15s, box-shadow .15s; }
.ch-input-wrap:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(99,191,214,.18); }
.ch-input-wrap.invalid { border-color: var(--red); }
.ch-input { width: 100%; border: none; background: none; outline: none; padding: 9px 0; font-size: 14px; color: var(--ink); min-width: 0; }
.ch-input::placeholder { color: var(--muted-2); }
.ch-input-prefix, .ch-input-suffix { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.ch-input-prefix { padding-right: 6px; }
.ch-input-suffix { padding-left: 6px; }
.ch-textarea { padding: 9px 10px; resize: vertical; border: 1.5px solid var(--line); border-radius: var(--r-sm); line-height: 1.5; }
.ch-textarea:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(99,191,214,.18); }

.ch-select-wrap { position: relative; padding-right: 0; }
.ch-select { appearance: none; padding-right: 26px; cursor: pointer; background: none; }
.ch-select-chev { position: absolute; right: 10px; pointer-events: none; color: var(--muted); font-size: 15px; }

/* ---------- Segmented ---------- */
.ch-seg { display: inline-flex; background: var(--cream); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 3px; gap: 3px; width: 100%; }
.ch-seg-btn { flex: 1; border: none; background: none; padding: 7px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--muted); cursor: pointer; transition: all .15s; white-space: nowrap; }
.ch-seg-btn.active { background: #fff; color: var(--ink); font-weight: 600; box-shadow: 0 1px 3px rgba(58,55,57,.12); }
.ch-seg.sm .ch-seg-btn { padding: 5px 8px; font-size: 12px; }

/* ---------- Toggle ---------- */
.ch-toggle-row { display: inline-flex; align-items: center; gap: 8px; background: none; border: none; cursor: pointer; padding: 0; }
.ch-toggle { width: 38px; height: 22px; border-radius: 999px; background: var(--cream-d); position: relative; transition: background .18s; flex: none; border: 1px solid var(--line); }
.ch-toggle.on[data-tone="blue"] { background: var(--blue); border-color: var(--blue); }
.ch-toggle.on[data-tone="teal"] { background: var(--teal); border-color: var(--teal); }
.ch-toggle-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .18s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.ch-toggle.on .ch-toggle-knob { transform: translateX(16px); }
.ch-toggle-label { font-size: 12.5px; font-weight: 600; color: var(--ink); }

/* ---------- Check ---------- */
.ch-check { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-size: 12.5px; font-weight: 500; color: var(--ink); }
.ch-check input { display: none; }
.ch-check-box { width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid var(--line); display: grid; place-items: center; color: #fff; font-size: 12px; background: #fff; transition: all .15s; }
.ch-check input:checked + .ch-check-box { background: var(--blue); border-color: var(--blue); }

/* ---------- Buttons ---------- */
.ch-btn { display: inline-flex; align-items: center; gap: 7px; border: none; border-radius: var(--r-sm); padding: 9px 14px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s; white-space: nowrap; }
.ch-btn:disabled { opacity: .45; cursor: not-allowed; }
.ch-btn-icon { font-size: 13px; line-height: 1; }
.ch-btn-sm { padding: 6px 10px; font-size: 12px; }
.ch-btn-primary { background: var(--blue); color: #fff; box-shadow: 0 2px 0 var(--blue-d); }
.ch-btn-primary:hover { filter: brightness(1.04); transform: translateY(-1px); }
.ch-btn-teal { background: var(--teal); color: #fff; box-shadow: 0 2px 0 var(--teal-d); }
.ch-btn-dark { background: var(--black); color: #fff; }
.ch-btn-dark:hover { filter: brightness(1.2); }
.ch-btn-outline { background: #fff; color: var(--ink); border: 1.5px solid var(--line); }
.ch-btn-outline:hover { border-color: var(--blue); color: var(--blue-d); }
.ch-btn-ghost { background: var(--cream); color: var(--ink); }
.ch-btn-ghost:hover { background: var(--cream-d); }
.ch-btn-ghostdanger { background: none; color: var(--muted); padding: 6px 9px; }
.ch-btn-ghostdanger:hover { background: rgba(236,58,36,.1); color: var(--red); }
.ch-btn-dashed { background: #fff; color: var(--muted); border: 1.5px dashed var(--line); }
.ch-btn-dashed:hover { border-color: var(--orange); color: var(--orange); background: #fffdf8; }

/* ---------- Badge ---------- */
.ch-badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
.ch-badge.tone-slate { background: var(--cream); color: var(--muted); }
.ch-badge.tone-blue { background: rgba(99,191,214,.16); color: var(--blue-d); }
.ch-badge.tone-teal { background: rgba(10,185,182,.14); color: var(--teal-d); }
.ch-badge.tone-orange { background: rgba(249,164,41,.16); color: #c47d12; }
.ch-badge.tone-red { background: rgba(236,58,36,.13); color: var(--red); }

/* ---------- Rate settings ---------- */
.ch-lock-note { background: var(--cream); border-radius: var(--r-md); padding: 11px 14px; font-size: 12.5px; color: var(--muted); margin-bottom: 14px; }
.ch-rate-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
.ch-rate-grid.disabled { opacity: .55; pointer-events: none; }
.ch-rate-col { display: flex; flex-direction: column; gap: 3px; }
.ch-rate-group-title { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--blue-d); margin: 12px 0 4px; }
.ch-rate-col .ch-rate-group-title:first-child { margin-top: 0; }
.ch-rate-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; }
.ch-rate-label { font-size: 13px; font-weight: 500; display: flex; flex-direction: column; }
.ch-rate-hint { font-size: 10.5px; color: var(--muted-2); }
.ch-rate-control { width: 132px; flex: none; }
@media (max-width: 620px) { .ch-rate-grid { grid-template-columns: 1fr; gap: 8px; } }

/* ---------- Itinerary (premium timeline) ---------- */
.ch-empty { padding: 48px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.ch-empty-icon { font-size: 34px; }
.ch-empty-title { color: var(--muted); font-size: 14px; }

.ch-timeline-wrap { padding: 22px 24px 8px; }
.ch-timeline { position: relative; }

.ch-tl-item { position: relative; display: grid; grid-template-columns: 30px 1fr; gap: 16px; }
.ch-tl-rail { position: relative; display: flex; justify-content: center; }
/* continuous line down the rail */
.ch-tl-item:not(:last-child) .ch-tl-rail::before { content: ''; position: absolute; top: 6px; bottom: -6px; left: 50%; transform: translateX(-50%); width: 2px; border-left: 2px dotted var(--muted-2); opacity: .55; }
.ch-marker { position: relative; z-index: 1; width: 18px; height: 18px; border-radius: 50%; margin-top: 4px; display: grid; place-items: center; font-size: 9px; color: #fff; box-shadow: 0 0 0 4px var(--paper); flex: none; }
.ch-marker.tone-teal { background: var(--teal); }
.ch-marker.tone-red { background: var(--red); }
.ch-marker.tone-blue { background: var(--blue); }
.ch-marker.ring { background: #fff; border: 2.5px solid var(--blue); }
.ch-marker.stay { background: #fff; border: 2px dashed var(--muted-2); color: var(--muted); }

.ch-tl-body { min-width: 0; padding-bottom: 8px; }

/* card */
.ch-tl-card { background: var(--paper); border: 1.5px solid var(--line); border-radius: 16px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; transition: border-color .15s, box-shadow .15s; }
.ch-tl-card:hover { border-color: var(--cream-d); box-shadow: var(--shadow-card); }
.ch-tl-card.tone-teal { border-top: 3px solid var(--teal); }
.ch-tl-card.tone-red { border-top: 3px solid var(--red); }
.ch-tl-card.tone-blue { border-top: 3px solid var(--blue); }

.ch-tl-head { display: flex; align-items: center; gap: 10px; }
.ch-tl-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.1px; padding: 4px 10px; border-radius: 999px; flex: none; }
.ch-tl-tag.tone-teal { background: rgba(10,185,182,.13); color: var(--teal-d); }
.ch-tl-tag.tone-red { background: rgba(236,58,36,.11); color: var(--red); }
.ch-tl-tag.tone-blue { background: rgba(99,191,214,.16); color: var(--blue-d); }
.ch-tl-cat { width: 175px; }
.ch-tl-cat .ch-input-wrap { padding: 0 10px; }
.ch-tl-cat .ch-input { padding: 6px 0; font-size: 12.5px; font-weight: 500; }
.ch-tl-actions { margin-left: auto; display: flex; gap: 6px; }
.ch-icon-btn { width: 30px; height: 30px; border: 1.5px solid var(--line); background: #fff; border-radius: 8px; cursor: pointer; font-size: 14px; color: var(--muted); display: grid; place-items: center; transition: all .15s; }
.ch-icon-btn:hover { border-color: var(--blue); color: var(--blue-d); }
.ch-icon-btn.danger:hover { border-color: var(--red); color: var(--red); background: rgba(236,58,36,.06); }

.ch-tl-title-field { display: flex; flex-direction: column; gap: 4px; }
.ch-tl-title-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; color: var(--muted-2); }
.ch-tl-route { display: flex; align-items: flex-end; gap: 12px; }
.ch-tl-route .ch-tl-title-field { flex: 1 1 0; min-width: 0; }
.ch-route-sep { font-size: 22px; color: var(--muted-2); padding-bottom: 9px; flex: none; }
.ch-tl-stoprow:empty { display: none; }
@media (max-width: 560px) { .ch-tl-route { flex-direction: column; align-items: stretch; gap: 8px; } .ch-route-sep { display: none; } }

/* place autocomplete */
.ch-ac { position: relative; }
.ch-tl-title-field .ch-ac { width: 100%; }
.ch-ac-menu { position: absolute; top: calc(100% + 5px); left: 0; right: 0; min-width: 230px; background: #fff; border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow-pop); padding: 6px; z-index: 60; max-height: 264px; overflow-y: auto; }
.ch-ac-item { display: flex; align-items: center; gap: 10px; width: 100%; border: none; background: none; padding: 9px 10px; border-radius: 8px; cursor: pointer; text-align: left; font-size: 14px; color: var(--ink); font-family: var(--sans); }
.ch-ac-item:hover, .ch-ac-item.hi { background: var(--cream); }
.ch-ac-pin { font-size: 13px; flex: none; opacity: .85; }
.ch-ac-name { font-weight: 400; color: var(--muted); }
.ch-ac-name b { font-weight: 700; color: var(--ink); }
.ch-tl-title { font-family: var(--serif); font-size: 21px; font-weight: 700; color: var(--ink); border: 1.5px solid var(--line); background: #fff; outline: none; padding: 7px 12px; border-radius: 10px; width: 100%; line-height: 1.2; transition: border-color .15s, box-shadow .15s; }
.ch-tl-title:hover { border-color: var(--cream-d); }
.ch-tl-title:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(99,191,214,.18); }
.ch-tl-title::placeholder { color: var(--muted-2); font-style: italic; font-weight: 600; }

.ch-tl-from { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: -4px; }
.ch-from-lbl { font-size: 12px; color: var(--muted); }
.ch-from-in { border: none; border-bottom: 1.5px solid var(--line); background: none; padding: 2px 2px; font-size: 13.5px; font-weight: 500; color: var(--ink); outline: none; min-width: 80px; max-width: 180px; }
.ch-from-in:focus { border-bottom-color: var(--blue); }
.ch-from-in::placeholder { color: var(--muted-2); font-weight: 400; }

.ch-stops { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.ch-stop-chip { display: inline-flex; align-items: center; gap: 4px; background: rgba(249,164,41,.13); color: #b9760f; border-radius: 999px; padding: 3px 7px 3px 9px; font-size: 11px; font-weight: 500; }
.ch-stop-x { border: none; background: none; color: #b9760f; cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }
.ch-stop-input { border: 1px dashed var(--line); background: #fff; border-radius: 999px; padding: 2px 9px; font-size: 11px; outline: none; width: 60px; }
.ch-stop-input:focus { border-color: var(--orange); width: 100px; }

.ch-tl-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ch-meta-date { display: inline-flex; align-items: center; gap: 6px; background: var(--cream); border-radius: 999px; padding: 5px 12px; font-size: 12.5px; }
.ch-meta-date .ch-meta-ic { font-size: 12px; opacity: .8; }
.ch-meta-date input { border: none; background: none; outline: none; font-family: inherit; font-size: 12.5px; color: var(--ink); font-weight: 500; }
.ch-meta-dist { display: flex; align-items: center; }
.ch-dist-pill { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 500; padding: 5px 12px; border-radius: 999px; background: var(--cream); color: var(--ink); }
.ch-dist-pill.auto { background: rgba(99,191,214,.12); color: var(--blue-d); }
.ch-dist-pill.warn { background: rgba(249,164,41,.13); color: #b9760f; }
.ch-dist-manual { display: flex; align-items: center; gap: 7px; }
.ch-link { border: none; background: none; color: currentColor; font-size: 11px; font-weight: 700; cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px; opacity: .75; }
.ch-link:hover { opacity: 1; }
.ch-meta-price { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; flex: none; }
.ch-price-lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: .7px; color: var(--muted-2); white-space: nowrap; }
.ch-price-val { font-family: var(--serif); font-size: 21px; font-weight: 700; color: var(--ink); }

/* driver / car stay toggles */
.ch-tl-stays { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--line-soft); }
.ch-stay-toggle { display: inline-flex; align-items: center; gap: 8px; border: 1.5px solid var(--line); background: #fff; border-radius: 10px; padding: 7px 12px; cursor: pointer; transition: all .15s; }
.ch-stay-toggle:hover { border-color: var(--muted-2); }
.ch-stay-ic { font-size: 15px; filter: grayscale(.4); opacity: .7; }
.ch-stay-lb { font-size: 13px; font-weight: 600; color: var(--muted); }
.ch-stay-state { font-size: 9px; font-weight: 800; letter-spacing: .6px; color: var(--muted-2); background: var(--cream); border-radius: 5px; padding: 2px 5px; }
.ch-stay-toggle.on { background: #fff; }
.ch-stay-toggle.on .ch-stay-ic { filter: none; opacity: 1; }
.ch-stay-toggle.on .ch-stay-lb { color: var(--ink); }
.ch-stay-toggle.on.tone-teal { border-color: var(--teal); background: rgba(10,185,182,.07); }
.ch-stay-toggle.on.tone-teal .ch-stay-state { background: var(--teal); color: #fff; }
.ch-stay-toggle.on.tone-blue { border-color: var(--blue); background: rgba(99,191,214,.08); }
.ch-stay-toggle.on.tone-blue .ch-stay-state { background: var(--blue); color: #fff; }
.ch-stays-note { font-size: 11.5px; color: var(--teal-d); font-weight: 600; }

.ch-tl-fees { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.ch-fee { display: inline-flex; align-items: center; gap: 9px; }
.ch-note-in { border: 1px solid var(--line); background: #fcfbf7; border-radius: var(--r-sm); padding: 8px 11px; font-size: 12.5px; outline: none; font-family: inherit; color: var(--ink); width: 100%; }
.ch-note-in:focus { border-color: var(--blue); background: #fff; }

/* connector between stops */
.ch-connector { display: flex; align-items: center; gap: 12px; padding: 12px 4px 12px 0; }
.ch-connector-node { width: 30px; height: 30px; border-radius: 50%; background: #fff; border: 1.5px solid var(--line); display: grid; place-items: center; font-size: 14px; color: var(--blue-d); flex: none; margin-left: -1px; }
.ch-connector-text { display: flex; flex-direction: column; line-height: 1.3; }
.ch-connector-text b { font-size: 13px; font-weight: 600; color: var(--ink); }
.ch-connector-text span { font-size: 12px; color: var(--muted); }
.ch-connector.rest .ch-connector-node { border-style: dashed; color: var(--muted); }

.ch-timeline-add { display: flex; gap: 10px; padding: 6px 0 4px 46px; flex-wrap: wrap; }
.ch-timeline-hint { padding: 12px 24px 18px 46px; font-size: 12px; color: var(--muted); }
.ch-timeline-hint b { color: var(--ink); font-weight: 600; }

.ch-cur-toggle { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--muted); font-weight: 500; }
.ch-cur-toggle .ch-seg { width: 100px; }

/* ---------- Summary ---------- */
.ch-km-strip { display: flex; gap: 10px; margin-bottom: 16px; }
.ch-km { flex: 1; background: var(--cream); border-radius: var(--r-md); padding: 11px; text-align: center; }
.ch-km.hero { background: var(--black); color: #fff; }
.ch-km b { font-family: var(--serif); font-size: 22px; font-weight: 700; display: block; line-height: 1; }
.ch-km span { font-size: 10.5px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); }
.ch-km.hero span { color: rgba(255,255,255,.7); }
.ch-sum-block { border: 1px solid var(--line); border-radius: var(--r-md); padding: 13px 15px; margin-bottom: 13px; }
.ch-sum-block.blue { border-left: 3px solid var(--blue); }
.ch-sum-block.teal { border-left: 3px solid var(--teal); }
.ch-sum-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13.5px; margin-bottom: 9px; }
.ch-dot { width: 9px; height: 9px; border-radius: 50%; }
.ch-dot.blue { background: var(--blue); }
.ch-dot.teal { background: var(--teal); }
.ch-line { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 4px 0; font-size: 13px; }
.ch-line-label { color: var(--muted); white-space: nowrap; }
.ch-line-label i { font-style: normal; color: var(--muted-2); font-size: 11.5px; }
.ch-line-val { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ch-line.strong { border-top: 1px solid var(--line); margin-top: 5px; padding-top: 9px; }
.ch-line.strong .ch-line-label { color: var(--ink); font-weight: 600; }
.ch-line.strong .ch-line-val { font-family: var(--serif); font-size: 21px; font-weight: 700; }
.ch-margin { font-size: 11.5px; color: var(--teal-d); text-align: right; margin-top: 3px; font-weight: 600; }
.ch-compare { background: var(--cream); border-radius: var(--r-md); padding: 13px 15px; }
.ch-compare-row { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; }
.ch-compare-row span { font-size: 13px; font-weight: 500; }
.ch-compare-row b { font-family: var(--serif); font-size: 19px; }
.ch-compare-note { font-size: 12px; color: var(--muted); margin-top: 8px; border-top: 1px solid var(--line); padding-top: 9px; }
.ch-tip { background: rgba(99,191,214,.1); border-radius: var(--r-md); padding: 11px 13px; font-size: 12.5px; color: var(--black); margin-top: 13px; line-height: 1.5; }
.ch-tip b { color: var(--blue-d); }

/* ---------- Flags ---------- */
.ch-flags-clear { color: var(--teal-d); font-size: 13px; font-weight: 500; padding: 4px 0; }
.ch-flags { display: flex; flex-direction: column; gap: 9px; }
.ch-flag { display: flex; gap: 11px; padding: 11px 13px; border-radius: var(--r-md); }
.ch-flag-mark { font-size: 13px; line-height: 1.4; flex: none; }
.ch-flag.tone-red { background: rgba(236,58,36,.08); }
.ch-flag.tone-red .ch-flag-mark { color: var(--red); }
.ch-flag.tone-orange { background: rgba(249,164,41,.1); }
.ch-flag.tone-orange .ch-flag-mark { color: var(--orange); }
.ch-flag.tone-blue { background: rgba(99,191,214,.1); }
.ch-flag.tone-blue .ch-flag-mark { color: var(--blue-d); }
.ch-flag-title { font-weight: 600; font-size: 13px; }
.ch-flag-detail { font-size: 12px; color: var(--muted); line-height: 1.45; margin-top: 2px; }

/* ---------- Output ---------- */
.ch-tabs { display: flex; gap: 4px; background: var(--cream); padding: 4px; border-radius: var(--r-md); margin-bottom: 14px; }
.ch-tab { flex: 1; border: none; background: none; padding: 9px; border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--muted); cursor: pointer; transition: all .15s; }
.ch-tab.active { background: #fff; color: var(--ink); font-weight: 600; box-shadow: 0 1px 3px rgba(58,55,57,.12); }
.ch-output-body { min-height: 120px; }
.ch-pre { font-family: var(--sans); font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; background: var(--cream); border-radius: var(--r-md); padding: 16px 18px; margin: 0; color: var(--ink); }
.ch-pre.mono { font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 12.5px; }
.ch-email-subject { font-size: 13px; margin-bottom: 10px; padding: 10px 14px; background: #fff; border: 1px solid var(--line); border-radius: var(--r-sm); }
.ch-email-subject span { font-size: 10.5px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted-2); margin-right: 8px; }
.ch-internal-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
.ch-internal-grid > div { background: var(--cream); border-radius: var(--r-sm); padding: 9px 11px; }
.ch-internal-grid span { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted-2); display: block; }
.ch-internal-grid b { font-size: 13.5px; }
.ch-itable { width: 100%; border-collapse: collapse; }
.ch-itable td { padding: 8px 12px; font-size: 13px; border-bottom: 1px solid var(--line-soft); }
.ch-itable td:last-child { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.ch-itable tr.sec td { color: var(--muted); }
.ch-itable tr.hi td { font-weight: 700; }
.ch-itable tr.hi.blue td:last-child { color: var(--blue-d); }
.ch-itable tr.hi.teal td:last-child { color: var(--teal-d); }
.ch-internal-note { font-size: 11.5px; color: var(--muted-2); margin-top: 12px; font-style: italic; }
@media (max-width: 520px) { .ch-internal-grid { grid-template-columns: repeat(2, 1fr); } }

/* ---------- Toast ---------- */
.ch-toast { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--black); color: #fff; padding: 12px 20px; border-radius: 999px; font-size: 13px; font-weight: 500; box-shadow: var(--shadow-pop); opacity: 0; pointer-events: none; transition: all .25s; z-index: 100; display: flex; align-items: center; gap: 8px; }
.ch-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.ch-toast .tick { color: var(--teal); }
```

---

## 2. Data Model

### 2.1 `quote` object

```ts
{
  id: string;                   // "Q-" + Date.now().toString(36).toUpperCase()
  customerName: string;         // default ""
  passengerCount: number;       // default 2
  luggageCount: number;         // default 2
  serviceType: "private" | "chauffeur";  // default "private" (not yet surfaced in UI)
  vehicleType: string;          // one of VEHICLES[*].id; default "van_6"
  outputCurrency: "LKR" | "USD"; // default "LKR"; applied only at output step
  status: string;               // one of STATUSES; default "Draft"
  internalNotes: string;        // default ""
  settings: Settings;           // see §2.4
  legs: Leg[];                  // default [newLeg()]
}
```

LocalStorage keys: `ch_quote_v2` (current quote), `ch_admin_v1` ("1"/"0"), `ch_saved_v2` (array, max 40 entries).

Saved-quote stamp shape: `{ id, name: customerName || "Untitled", status, total: computed.totals.finalRecommendedTotal, at: Date.now(), quote }`.

### 2.2 `leg` object

```ts
{
  id: string;                   // "leg_" + Date.now().toString(36) + "_" + seq
  date: string;                 // ISO date "YYYY-MM-DD", default ""
  pickupLocation: string;       // default ""
  dropoffLocation: string;      // default ""
  stopovers: string[];          // default []
  category: string;             // one of CATEGORIES[*].id; default "transfer"
  distanceKm: number;           // default 0
  driveTimeHours: number;       // default 0
  manualDistance: boolean;      // default false — user overriding auto-calc
  autoMatched: boolean;         // default false — set true when estimateRoute matched
  addSightseeingFee: boolean;   // default false
  sightseeingFeeLkr: number;    // default 3000 (copies from settings on first enable)
  addWaitingFee: boolean;       // default false
  waitingFeeLkr: number;        // default 2000 (copies from settings on first enable)
  hasDriver: boolean;           // default false — driver stays overnight on this date
  hasCarStay: boolean;          // default false — car stays overnight on this date
  notes: string;                // default ""
}
```

### 2.3 `CH.CATEGORIES`

```js
[
  { id: "transfer",       label: "Transfer",                   drives: true  },
  { id: "stay_day",       label: "Stay day",                   drives: false },
  { id: "train_support",  label: "Train / luggage support",    drives: true  },
  { id: "sightseeing",    label: "Sightseeing / waiting",      drives: true  },
  { id: "safari_wait",    label: "Safari waiting",             drives: true  },
  { id: "airport",        label: "Airport pickup / drop-off",  drives: true  },
]
```

Behavior flag `drives: true` means the category incurs km-based pricing and auto-distance estimation runs. `drives: false` (stay_day only) means the leg card shows a single "Staying at" field instead of From → Destination, and no distance is calculated.

### 2.4 `CH.VEHICLES`

```js
[
  { id: "car",    label: "Car",         cls: "car",    pax: 3,  bags: 3  },
  { id: "van_6",  label: "Van 6 Seat",  cls: "van",    pax: 6,  bags: 5  },
  { id: "van_9",  label: "Van 9 Seat",  cls: "van",    pax: 9,  bags: 8  },
  { id: "van_14", label: "Van 14 Seat", cls: "van",    pax: 14, bags: 12 },
  { id: "custom", label: "Custom",      cls: "custom", pax: 99, bags: 99 },
]
```

The `cls` field drives which per-km rate to use. `custom` uses `customPerKmRate` and has no minimum km floor (minForClass returns 0).

### 2.5 `CH.STATUSES` and `STATUS_TONE`

```js
const STATUSES = ["Draft", "Ready to Send", "Sent", "Booked", "Lost"];

const STATUS_TONE = {
  "Draft":         "var(--muted-2)",
  "Ready to Send": "var(--teal)",
  "Sent":          "var(--blue)",
  "Booked":        "var(--orange)",
  "Lost":          "var(--red)",
};
```

The status dot in the header uses `STATUS_TONE[quote.status]` as its `background` inline style.

### 2.6 `settings` object (default values)

```js
{
  carPerKmRate: 75,                // LKR/km
  vanPerKmRate: 95,                // LKR/km
  customPerKmRate: 120,            // LKR/km
  markupPercent: 25,               // percent
  chauffeurDailyDriverCharge: 5000,// LKR/day
  bataLkrPerDay: 5000,             // LKR/day (added to chauffeurDailyDriverCharge when hasDriver)
  accommodationLkrPerNight: 2500,  // LKR/night (when hasCarStay)
  localSightseeingFeeLkr: 3000,    // LKR (default value copied into leg.sightseeingFeeLkr on first enable)
  waitingFeeLkr: 2000,             // LKR (default value copied into leg.waitingFeeLkr on first enable)
  usdLkrExchangeRate: 305,         // LKR per USD
  carMinKm: 50,                    // minimum billable km for car class
  vanMinKm: 100,                   // minimum billable km for van class
  roundingMode: "nearest_500",     // "nearest_100" | "nearest_500" | "nearest_1000"
}
```

On `loadQuote()`, `settings` is backfilled with defaults via `Object.assign(CH.defaultSettings(), q.settings || {})` so new keys always appear even on old saved quotes.

---

## 3. Component-by-Component Layout

### 3.1 App Shell / Header

```
<div class="ch-app">
  <header class="ch-header">
    <div class="ch-header-in">
      [brand]
        <div class="ch-mark">C</div>          ← 38×38 circle, Bodoni "C"
        <div class="ch-brand-txt">
          <b>Ceylon Hop</b>                    ← Bodoni 19px 700
          <span>Ops · Quote Generator</span>   ← 10.5px caps, 2.2px tracking
        </div>
      [spacer flex:1]
      [ch-header-tools]
        .ch-status pill:
          .dot (inline background = STATUS_TONE color)
          <select> (CH.STATUSES options)
        Button variant="ghost" icon="＋" → newQuote()       "New"
        Button variant="dark" icon="💾" → saveQuote(false)  "Save"
        CopyButton text=whatsappMessage  label="WhatsApp" variant="primary"
        CopyButton text=emailMessage     label="Email"    variant="outline"
        CopyButton text=notionTable      label="Notion"   variant="outline"
    </div>
  </header>

  <div class="ch-container">
    <div class="ch-main">                ← 2-col grid: 1.62fr / 0.92fr, gap 20px
      <div class="ch-col-l">            ← left column: flex col, gap 20px
        <CustomerCard />
        <SettingsCard />
        <ItineraryCard />
      </div>
      <div class="ch-col-r">            ← right column: sticky top:86px
        <SummaryCard />
        <FlagsCard />
      </div>
    </div>
    <div class="ch-output-wrap">        ← full width below the 2-col
      <OutputCard />
    </div>
  </div>

  <div class="ch-toast [show]">
    <span class="tick">✓</span>{toast}
  </div>
</div>
```

The `Card` primitive renders: `<section class="ch-card">` containing `<header class="ch-card-head">` (always visible) and `<div class="ch-card-body [nopad]">` (hidden when `collapsible && !open`). Card header has left side (icon badge + `<h2>`) and right side (arbitrary `right` prop content + optional chevron). The icon badge (`ch-card-icon`) overrides background with the `accent` color prop.

### 3.2 CustomerCard — "① Customer & Request"

Icon: `①`, accent: `var(--blue)`.

```
Row 1 (ch-row):
  Field label="Customer name" grow w=220
    TextInput value=customerName placeholder="e.g. Karen"
  Field label="Passengers" required hint=errors.passengerCount w=120
    NumInput min=0 invalid=!!errors.passengerCount prefix="👥" value=passengerCount
  Field label="Bags / luggage" required hint=errors.luggageCount w=130
    NumInput min=0 invalid=!!errors.luggageCount prefix="🧳" value=luggageCount

Row 2 (ch-row):
  Field label="Vehicle type" required hint=errors.vehicleType w=180
    Select value=vehicleType options=CH.VEHICLES.map(v=>({value:v.id,label:v.label}))

[Conditional warning banner — only when vehicleType==="car" && luggageCount > 3]
  Inline div: background rgba(249,164,41,.13), border-radius 13px, padding 11px 14px,
  font-size 13px, color #b9760f, font-weight 500
  Text: "⚠️ A car can only accommodate max 3 bags. You've selected {luggageCount}. Please confirm or choose a larger vehicle."

Field label="Internal notes" (no grow, full width)
  <textarea class="ch-input ch-textarea" rows=2 value=internalNotes
    placeholder="Anything ops should remember about this request…" />
```

Validation errors (`errors` object in App): `passengerCount` and `luggageCount` required (empty or null → "Required"), `vehicleType` required if falsy.

### 3.3 SettingsCard — "② Rate Settings"

Icon: `②`, accent: `var(--black)`, collapsible (starts closed: `settingsOpen` initialized to `false`).

Header right slot:
```
<div class="ch-head-tools" onClick={(e) => e.stopPropagation()}>
  Badge tone={admin?"teal":"slate"}: "Admin unlocked" or "Locked"
  Button size="sm" variant={admin?"ghost":"outline"} icon={admin?"🔓":"🔒"}
    onClick → setAdmin(!admin)
    Label: admin ? "Lock" : "Admin"
</div>
```

When locked (`!admin`): `ch-lock-note` paragraph: "All rates are in **LKR** and locked. Click **Admin** to edit global pricing — ops can quote safely without changing rates by accident."

Grid layout: `ch-rate-grid` (2 cols, `disabled` class added when locked):

**Left column** (`ch-rate-col`):

Group title: "Per-km rates (LKR)"
- "Car" → NumInput prefix="Rs" suffix="/km" → `carPerKmRate`
- "Van" → NumInput prefix="Rs" suffix="/km" → `vanPerKmRate`
- "Custom" → NumInput prefix="Rs" suffix="/km" → `customPerKmRate`

Group title: "Minimums & rounding"
- "Car minimum" → NumInput suffix="km" → `carMinKm`
- "Van minimum" → NumInput suffix="km" → `vanMinKm`
- "Round up to" → Select options: `[{nearest_100,"Nearest 100"},{nearest_500,"Nearest 500"},{nearest_1000,"Nearest 1000"}]` → `roundingMode`

**Right column** (`ch-rate-col`):

Group title: "Markup & chauffeur (LKR)"
- "Markup" → NumInput suffix="%" → `markupPercent`
- "Driver / day" → NumInput prefix="Rs" suffix="/day" → `chauffeurDailyDriverCharge`
- "Bata / day" → NumInput prefix="Rs" suffix="/day" → `bataLkrPerDay`
- "Accommodation / night" → NumInput prefix="Rs" suffix="/night" → `accommodationLkrPerNight`

Group title: "Add-ons & FX"
- "Sightseeing fee" → NumInput prefix="Rs" → `localSightseeingFeeLkr`
- "Waiting fee" → NumInput prefix="Rs" → `waitingFeeLkr`
- "USD → LKR rate" hint="for output conversion" → NumInput prefix="Rs" → `usdLkrExchangeRate`

Each row uses `RateRow` component: `ch-rate-row` div with left label (`ch-rate-label`) and right control (`ch-rate-control`, width: 132px fixed).

### 3.4 ItineraryCard — "③ Itinerary"

Icon: `③`, accent: `var(--orange)`, `pad={false}` (body has no padding), `right=<Badge tone="slate">{N} stops · {D} driver nights</Badge>`.

**Empty state** (legs.length === 0):
```
<div class="ch-empty">
  <div class="ch-empty-icon">🗺️</div>
  <div class="ch-empty-title">Build the journey stop by stop to start pricing.</div>
  Button variant="primary" icon="＋" onClick→addLeg("transfer"): "Add first stop"
</div>
```

**With legs** (`ch-timeline-wrap > ch-timeline`):

For each leg at index `i`, render `LegCard` then (if not last) a `Connector` between cards. Below all legs, the add-leg row:
```
<div class="ch-timeline-add">
  Button variant="dashed" icon="＋" → addLeg("transfer"):   "Add transfer"
  Button variant="dashed" icon="☾" → addLeg("stay_day"):   "Add stay day"
  Button variant="dashed" icon="📸" → addLeg("sightseeing"): "Add sightseeing"
</div>
<div class="ch-timeline-hint">
  Set <b>Driver stays</b> / <b>Car stays</b> on each night to build up the chauffeur rate.
</div>
```

#### 3.4.1 LegCard internal layout

The `ch-tl-item` uses a 2-column grid: 30px rail column + 1fr body column.

**Rail**: `ch-tl-rail` contains `ch-marker tone-{tone} [stay] [ring]`:
- `index === 0` → tone `teal`, solid teal fill
- `index === totalLegs-1` → tone `red`, solid red fill
- stay_day at middle position → class `stay` (dashed outline, moon glyph `☾`)
- other middle → class `ring` (white fill with blue border)

**Tag labels**: `isFirst ? "TRIP START" : isLast ? "FINAL STOP" : "STOP {index+1}"`

The dotted rail line is a CSS `::before` pseudo-element on `ch-tl-item:not(:last-child) .ch-tl-rail`.

**`ch-tl-card` (tone-{teal|red|blue} sets 3px top border)**:

```
Section 1 — ch-tl-head:
  span.ch-tl-tag.tone-{tone}: "{TAG}"
  div.ch-tl-cat (width 175px):
    Select value=leg.category options=CH.CATEGORIES
  div.ch-tl-actions:
    <button class="ch-icon-btn" title="Duplicate" onClick→dupLeg>⧉</button>
    <button class="ch-icon-btn danger" title="Remove" onClick→removeLeg>×</button>

Section 2 — route area:
  IF isStay (stay_day):
    <label class="ch-tl-title-field">
      <span class="ch-tl-title-lbl">Staying at</span>
      PlaceInput value=leg.dropoffLocation className="ch-tl-title" placeholder="Where are they staying?"
    </label>
  ELSE:
    <div class="ch-tl-route">
      <label class="ch-tl-title-field">
        <span class="ch-tl-title-lbl">From</span>
        PlaceInput value=leg.pickupLocation className="ch-tl-title" placeholder="Origin"
      </label>
      <span class="ch-route-sep">→</span>
      <label class="ch-tl-title-field">
        <span class="ch-tl-title-lbl">Destination</span>
        PlaceInput value=leg.dropoffLocation className="ch-tl-title" placeholder="Destination"
      </label>
    </div>
    <div class="ch-tl-stoprow">
      StopoverChips stops=leg.stopovers
    </div>

Section 3 — ch-tl-meta:
  label.ch-meta-date: 📅 <input type="date" value=leg.date>
  [IF !isStay] div.ch-meta-dist — three states:
    manualDistance=true:
      NumInput w=86 value=leg.distanceKm suffix="km"
      NumInput w=86 value=leg.driveTimeHours step=0.25 suffix="hr"
      <button class="ch-link" onClick→u({manualDistance:false})>auto</button>
    autoMatched=true:
      span.ch-dist-pill.auto: "≈ {distanceKm} km · ~{fmtDuration(driveTimeHours)}"
      <button class="ch-link" onClick→u({manualDistance:true})>edit</button>
    else (no match):
      span.ch-dist-pill.warn: "No distance"
      <button class="ch-link" onClick→u({manualDistance:true})>set</button>
  div.ch-meta-price (margin-left: auto):
    span.ch-price-lbl: "Leg price"
    span.ch-price-val: {fmtMoney(row.price, outputCurrency, usdLkrExchangeRate)}

Section 4 — ch-tl-stays (padded top, light border-top):
  StayToggle on=hasDriver icon="🧑‍✈️" label="Driver stays" tone="teal"
  StayToggle on=hasCarStay icon="🚙" label="Car stays" tone="blue"
  [IF hasDriver || hasCarStay]:
    span.ch-stays-note: "+ chauffeur rate for this date"

Section 5 — ch-tl-fees:
  label.ch-fee:
    Check checked=leg.addSightseeingFee label="Sightseeing fee"
      onChange: u({addSightseeingFee:v, sightseeingFeeLkr: leg.sightseeingFeeLkr || settings.localSightseeingFeeLkr})
    [IF addSightseeingFee]: NumInput w=100 prefix="Rs" value=leg.sightseeingFeeLkr
  label.ch-fee:
    Check checked=leg.addWaitingFee label="Waiting fee"
      onChange: u({addWaitingFee:v, waitingFeeLkr: leg.waitingFeeLkr || settings.waitingFeeLkr})
    [IF addWaitingFee]: NumInput w=100 prefix="Rs" value=leg.waitingFeeLkr

Section 6 — notes (conditional: only shown when addSightseeingFee OR addWaitingFee OR notes non-empty):
  <input class="ch-note-in" value=leg.notes
    placeholder="Note (e.g. 1–3 hr temple stop, safari wait)…" />
```

**StayToggle** (`ch-stay-toggle [on tone-{teal|blue}]`): displays icon, label, and a pill state badge "ON"/"OFF".

**StopoverChips**: renders existing chips as `span.ch-stop-chip` (with `×` button), then an inline `<input class="ch-stop-input" placeholder="+ stop">` that adds on Enter or blur.

**PlaceInput**: offline autocomplete against `CH.PLACES_LIST` (40 Sri Lanka locations). Shows max 6 matches, sorted by position of query in the string then by string length. Keyboard nav: ArrowUp/Down to move, Enter to pick, Escape to close. Match highlighting wraps the query substring in `<b>`.

**Connector** (between legs): renders `ch-connector [rest]`:
- If next leg is `stay_day` → `☾` node, "Rest day / No transfer — vehicle on standby"
- Else → `🚗` node, "Private transfer / {dist} km · ~{duration} drive" (or "Set the route to estimate distance")

**Auto-distance effect**: on each `LegCard`, a `useEffect` watching `[pickupLocation, dropoffLocation, manualDistance, drives]` calls `CH.estimateRoute` and patches `distanceKm`, `driveTimeHours`, `autoMatched`. If no match found and previously auto-matched, resets to 0.

**`addLeg` logic**: copies previous leg's `dropoffLocation` as the new leg's `pickupLocation`, auto-increments date by 1 day. For `stay_day`, sets both pickup and dropoff to the previous leg's dropoff.

**`dupLeg` logic**: finds leg by index, creates a new leg with all same fields but a new UUID, splices it in immediately after the original.

### 3.5 SummaryCard — "④ Pricing Summary"

Icon: `④`, accent: `var(--blue)`, `right=<Badge tone="slate">LKR · internal</Badge>`.

Always shows LKR (internal view — uses `L(lkr)` = `fmtMoney(lkr, "LKR", null)`).

```
ch-km-strip (3 tiles):
  ch-km:      {totals.totalDistanceKm}  "distance km"
  ch-km:      +{totals.totalBufferKm}   "buffer km"
  ch-km.hero: {totals.totalBillableKm}  "billable km"   ← dark background

ch-sum-block.blue ("Cost build-up" with blue dot):
  LineItem: "Vehicle (km × rate)" sub="· {billableKm} km" → L(vehicleCost)
  [IF extrasCost > 0]:
    LineItem: "Sightseeing / waiting" → L(extrasCost)
  [IF driverCost > 0]:
    LineItem: "Driver stays" sub="· {N} night(s)" → L(driverCost)
  [IF carStayCost > 0]:
    LineItem: "Car / accommodation" sub="· {N} night(s)" → L(carStayCost)
  LineItem: "Subtotal" → L(subtotal)
  LineItem: "Markup" sub="· {markupPercent}%" → L(markupAmount)
  LineItem strong accent=var(--blue-d): "Quote total" → L(grandTotal)
  div.ch-margin: "Est. margin {L(margin)}"

[Conditional tip — if |lineItemsTotal - grandTotal| > 1]:
  ch-tip: "Heads up — the sum of per-leg line items ({L(lineItemsTotal)}) differs from the
           rounded quote total ({L(grandTotal)}) because each leg is rounded individually.
           Send line items for transparency or the quote total for a single price."

[Conditional tip — if legs with drives >= 3]:
  ch-tip: "Pricing tip — 3+ transfers. Keep the first leg sharp, then protect margin on
           later legs (2nd-best, then 3rd-best rate)."
```

`LineItem` component: `ch-line [strong]`, label left (`ch-line-label` with optional `<i>` for sub), value right (`ch-line-val`, optional `accent` inline color). The `strong` variant adds a top border and uses Bodoni 21px for the value.

### 3.6 FlagsCard — "⑤ Operational Flags"

Icon: `⑤`, accent: `var(--orange)`, `right=<Badge tone={flags.length?"orange":"teal"}>{flags.length || "All clear"}</Badge>`.

```
IF flags.length === 0:
  div.ch-flags-clear: "✓ No warnings. This itinerary looks clean to send."
ELSE:
  div.ch-flags (flex col, gap 9px):
    FOREACH flag:
      div.ch-flag.tone-{flag.level}:
        span.ch-flag-mark: ▲ (red) | ● (orange) | ℹ (blue)
        div:
          div.ch-flag-title: {flag.title}
          div.ch-flag-detail: {flag.detail}
```

### 3.7 OutputCard — "⑥ Quote Output"

Icon: `⑥`, accent: `var(--teal)`.

Header right slot (shown when tab !== "internal"):
```
div.ch-head-tools:
  div.ch-cur-toggle:
    span: "Send in"
    Segmented size="sm" value=outputCurrency onChange→patch({outputCurrency:v})
      options: [{value:"LKR",label:"LKR"},{value:"USD",label:"USD"}]
  CopyButton text={copyText} label={"Copy " + tabLabel}
```

Four tabs (ch-tabs bar with 4 ch-tab buttons):
1. "Internal Calc" (id: "internal")
2. "WhatsApp" (id: "whatsapp") — default active
3. "Email" (id: "email")
4. "Notion" (id: "notion")

Tab content area (`ch-output-body`):
- **internal**: `InternalView` component (see below)
- **email**: `<div class="ch-email">` containing `<div class="ch-email-subject"><span>Subject</span> Ceylon Hop Transport Quote for Your Sri Lanka Trip</div>` then `<pre class="ch-pre">{emailMessage}</pre>`
- **whatsapp**: `<pre class="ch-pre">{whatsappMessage}</pre>`
- **notion**: `<pre class="ch-pre mono">{notionTable}</pre>`

**InternalView**: `ch-internal` div:
```
ch-internal-grid (3-col grid):
  Customer: {customerName || "—"}
  Pax / Bags: {passengerCount} / {luggageCount}
  Vehicle: {vehicleType label}
  Driver nights: {totals.driverDays}
  Status: {quote.status}
  FX: Rs {usdLkrExchangeRate}/$

ch-itable (table, full width):
  Total distance    | {totalDistanceKm} km
  Total buffer      | +{totalBufferKm} km
  Total billable    | {totalBillableKm} km
  [tr.sec] Vehicle cost     | {L(vehicleCost)}
  [IF extrasCost] Sightseeing / waiting | {L(extrasCost)}
  [IF driverCost] Driver stays ({driverDays}) | {L(driverCost)}
  [IF carStayCost] Car / accommodation ({carStayNights}) | {L(carStayCost)}
  Subtotal          | {L(subtotal)}
  Markup ({markupPercent}%) | {L(markupAmount)}
  [tr.hi.blue] Quote total | {L(grandTotal)}
  Est. margin       | {L(margin)}

ch-internal-note (italic):
  "For ops only — do not send to customer. All figures in LKR at {markupPercent}% markup."
```

---

## 4. Flags Logic

Flags are computed by `CH.computeFlags(quote, legRows, totals)` and returned as `{ level: "red"|"orange"|"blue", title: string, detail: string }[]`.

| Level | Title | Condition |
|-------|-------|-----------|
| red | Car luggage limit | `vehicleType === "car" && luggageCount > 3`. Detail: "A car fits a maximum of 3 bags — {luggageCount} requested. Confirm with the customer or size up to a van." |
| red | Long drive warning | Any leg has `driveTimeHours >= 6`. Detail: "A leg is 6+ hours on the road. Confirm the customer understands the travel time and consider a break or an overnight stop." |
| orange | Hectic itinerary warning | 3+ consecutive calendar dates among `drives=true` legs. Detail: "Customer is moving on 3+ consecutive days. Consider adding a stay day or trimming stops." |
| orange | Capacity warning | `v.id !== "custom"` AND (`passengerCount > v.pax` OR `luggageCount > v.bags`). Detail: "{passengerCount} pax + {luggageCount} bags may not fit a {v.label}. Confirm vehicle type or size up." |
| orange | Driver stays without the car | Any leg where `hasDriver === true && hasCarStay === false`. Detail: "A date has the driver staying but the car returning. Confirm this is intended — usually the car stays with the driver." |
| orange | Safari waiting flagged | Any leg where `category === "safari_wait"`. Detail: "Review safari waiting time and entry timing separately before sending." |
| blue | Van minimum applied | Any leg where `minApplied === true && cls === "van"`. Detail: "Minimum 100 km charge used on one or more legs." |
| blue | Car minimum applied | Any leg where `minApplied === true && cls === "car"`. Detail: "Minimum 50 km charge used on one or more legs." |
| blue | Airport timing reminder | Any leg where `category === "airport"` OR `/airport|cmb|katunayake/i` matches `pickupLocation + " " + dropoffLocation`. Detail: "Confirm flight number, landing/departure time, and buffer time." |
| blue | Stopover included | Any leg where `stopovers.filter(Boolean).length > 0`. Detail: "Confirm whether each stop is a quick break, sightseeing, safari wait, or multi-hour stop." |
| blue | Check distances | Any `drives=true` leg where `dist <= 0 && !autoMatched && !manualDistance`. Detail: "One or more legs couldn't be auto-located. Enter the distance manually to price them." |

Helper `maxConsecutiveDates(dates)`: computes the longest run of consecutive calendar days in the provided ISO date array (using Set dedup, sorting numerically by epoch day).

---

## 5. Output Templates

### 5.1 `CH.whatsappMessage(quote, computed)`

```js
function whatsappMessage(quote, computed) {
  const name = quote.customerName || "there";
  const veh = VEHICLE_BY_ID[quote.vehicleType].label;
  const t = computed.totals;
  const lines = [];
  lines.push(`Hi ${name}, thank you for sharing the details.`, "", "We can help with this. Based on your itinerary, here is the quote:", "");
  chargeRows(quote, computed).forEach((r) => lines.push(`${fmtDate(r.leg.date)} — ${routeText(r.leg)} — ${M(r.price, quote)}`));
  lines.push("", `Total: ${M(t.lineItemsTotal, quote)}`, "", `This is for a private ${veh} and includes fuel, driver cost, tolls, and pickup/drop-off from your locations.`);
  if (t.driverDays > 0) lines.push("It also covers the driver staying with you for the nights marked, including driver meals and accommodation.");
  lines.push("", "Please let me know if you have any questions or if you would like to proceed.");
  return lines.join("\n");
}
```

`chargeRows` = `computed.legRows.filter(r => r.price > 0)`. `M(lkr, quote)` = `fmtMoney(lkr, quote.outputCurrency, quote.settings.usdLkrExchangeRate)`.

`routeText(leg)`:
- stay_day → `"Stay in " + (leg.dropoffLocation || leg.pickupLocation || "?")`
- else → `[pickupLocation || "?", ...stopovers.filter(Boolean), dropoffLocation || "?"].join(" → ")`

`fmtDate(iso)`: formats to `dd MMM` in `en-GB` locale (e.g. "05 Aug"). Returns `"—"` if empty.

### 5.2 `CH.emailMessage(quote, computed)`

```js
function emailMessage(quote, computed) {
  const name = quote.customerName || "there";
  const veh = VEHICLE_BY_ID[quote.vehicleType].label;
  const t = computed.totals;
  const lines = [`Hi ${name},`, "", "Thank you for reaching out to Ceylon Hop. Based on the itinerary you shared, please find the transport quote below.", ""];
  chargeRows(quote, computed).forEach((r) => lines.push(`  ${fmtDate(r.leg.date)}   ${routeText(r.leg)}   ${M(r.price, quote)}`));
  lines.push("", `Total (private ${veh}): ${M(t.lineItemsTotal, quote)}`);
  lines.push("", "This quote includes fuel, driver cost, tolls, and pickup/drop-off from the agreed locations.", "", "Please let us know if you would like to proceed and we can send over the booking/payment details.", "", "Best,", "Roshen", "Ceylon Hop");
  return lines.join("\n");
}
```

Email subject (hardcoded in OutputCard JSX): `Ceylon Hop Transport Quote for Your Sri Lanka Trip`

### 5.3 `CH.notionTable(quote, computed)`

```js
function notionTable(quote, computed) {
  const t = computed.totals;
  const veh = VEHICLE_BY_ID[quote.vehicleType].label.toUpperCase();
  const out = [];
  out.push("| Date | Route | Price Given |", "|---|---|---|");
  chargeRows(quote, computed).forEach((r) => out.push(`| ${fmtDate(r.leg.date)} | ${routeText(r.leg)} | ${M(r.price, quote)} |`));
  out.push(`| PRIVATE TRANSFER VIA ${veh} |  | ${M(t.lineItemsTotal, quote)} |`);
  return out.join("\n");
}
```

Rendered with class `ch-pre mono` (monospace font).

---

## 6. Pricing Touchpoints

### 6.1 Distance estimation — `CH.estimateRoute(from, to)`

Client-side only. Looks up both location strings in a hardcoded `PLACES` dictionary (50 Sri Lanka lat/lon pairs). Normalization strips: "station", "safari", "national park", "np", "fort", "beach", "town", "city" suffixes; lowercases; removes non-alpha-space. Partial match: any key contained in input or vice versa (longest key wins).

Distance: `great_circle × 1.35`, rounded to nearest 5 km, floored at 3 km.
Speed: `>120 km → 42 km/h`, `>50 km → 36 km/h`, else `28 km/h`.
Drive time: rounded to nearest 15 min.

Returns `{ km, hours, matched: true }` or `{ matched: false }`.

**This entire engine is replaced by a call to the server `/estimate` endpoint in the rebuild.**

### 6.2 `CH.legMetrics(leg, quote)` — per-leg cost inputs

Inputs consumed:
- `leg.category` → determines `drives` flag
- `leg.distanceKm` (raw distance as entered or auto-calculated)
- `quote.vehicleType` → `cls` → selects rate and minimum
- `quote.settings.carPerKmRate / vanPerKmRate / customPerKmRate`
- `quote.settings.carMinKm / vanMinKm`
- `leg.addSightseeingFee`, `leg.sightseeingFeeLkr`
- `leg.addWaitingFee`, `leg.waitingFeeLkr`
- `leg.hasDriver` → `settings.chauffeurDailyDriverCharge + settings.bataLkrPerDay`
- `leg.hasCarStay` → `settings.accommodationLkrPerNight`

Buffer logic:
- `buffer = dist > 50 ? 10 : 5` (km added to actual distance)
- `billable = Math.max(raw, minKm)` where `raw = dist + buffer`
- `minApplied = raw < minKm && minKm > 0`

Outputs: `{ cat, dist, drives, cls, rate, minKm, buffer, raw, billable, minApplied, sightFee, waitFee, extras, vehicleCost, driverCost, carStayCost, stayCost, baseCost }`

### 6.3 `CH.legPrice(leg, quote)` — per-leg customer price (LKR)

```js
const withMarkup = baseCost * (1 + settings.markupPercent / 100);
return roundUp(withMarkup, settings.roundingMode);
```

`roundUp(x, mode)`: `Math.ceil(x / n) * n` where n = 100, 500, or 1000.

### 6.4 `CH.compute(quote)` — master compute

Inputs: the full `quote` object.

Outputs `{ legRows, totals, flags, fx }`:

```ts
legRows: Array<{ leg, m: legMetrics, price: legPrice }>

totals: {
  totalDistanceKm: number,     // sum of m.dist across all legs
  totalBufferKm: number,       // sum of m.buffer
  totalBillableKm: number,     // sum of m.billable
  vehicleCost: number,         // sum of m.vehicleCost (LKR, pre-markup)
  extrasCost: number,          // sum of m.extras (sightseeing + waiting fees)
  driverCost: number,          // sum of m.driverCost
  carStayCost: number,         // sum of m.carStayCost
  driverDays: number,          // count of legs with hasDriver=true
  carStayNights: number,       // count of legs with hasCarStay=true
  subtotal: number,            // vehicleCost + extrasCost + driverCost + carStayCost
  markupAmount: number,        // subtotal × markupPercent/100
  grandTotal: number,          // roundUp(subtotal + markupAmount) — single rounded total
  lineItemsTotal: number,      // sum of per-leg rounded prices (what customer sees)
  margin: number,              // grandTotal - subtotal
  finalRecommendedTotal: number, // === grandTotal (used for save stamp)
}

flags: Flag[]

fx: number  // settings.usdLkrExchangeRate (for use in output formatting)
```

Note: `grandTotal` (rounded once on the whole) vs `lineItemsTotal` (sum of individually-rounded legs) will diverge when there are multiple legs — the SummaryCard shows a tip about this.

### 6.5 FX conversion — `CH.fmtMoney(lkr, cur, fx)`

```js
if (cur === "USD") return "$" + Math.round(lkr / fx).toLocaleString("en-US");
return "LKR " + Math.round(lkr).toLocaleString("en-US");
```

Conversion happens only at the display layer (output templates and leg price display). All internal math is LKR throughout.

### 6.6 What must be server-replaced in rebuild

The following client-side computations in `CH` (file `a5b42bed`) are pure JS running in-browser with no server call. In the server-backed rebuild, **all of these must be replaced by a call to the `/estimate` API endpoint**:

1. `estimateRoute(from, to)` — distance/time estimation from the hardcoded `PLACES` lookup
2. `legMetrics(leg, quote)` — per-leg cost breakdown
3. `legPrice(leg, quote)` — per-leg rounded customer price
4. `compute(quote)` — the master computation producing `totals`, `legRows`, and `flags`

The UI components (`LegCard`, `SummaryCard`, `FlagsCard`, output templates) can remain client-side and simply consume the server response instead of calling `CH.compute`. The `computed` prop shape (especially `totals` and `legRows[].price`) must be preserved for the existing component trees to work without changes.

---

## Appendix: File → Component Map

| File | Contents |
|------|----------|
| `a5b42bed-b71b-49cf-965b-85a8295f7bd0.js` | `window.CH` namespace: VEHICLES, CATEGORIES, STATUSES, PLACES, defaultSettings, defaultQuote, sampleQuote, newLeg, uid, estimateRoute, legMetrics, legPrice, compute, computeFlags, fmtMoney, fmtDate, fmtDuration, routeText, whatsappMessage, emailMessage, notionTable |
| `e2b09326-baed-428f-a638-091af5b1e896.js` | Shared UI primitives: `Card, Field, TextInput, NumInput, Select, Segmented, Toggle, Check, Button, Badge, CopyButton`; also exposes React hooks as globals (useState, useEffect, useRef, useMemo) |
| `7b1928a8-7f90-408e-83b1-060cae239a61.js` | `CustomerCard, SettingsCard, RateRow` |
| `518dcb27-f0b3-49c1-9498-0fa9dbfd62d1.js` | `PlaceInput, StopoverChips, StayToggle, Connector, LegCard, ItineraryCard` |
| `33fa2776-5f75-45c6-80f6-1b523509d843.js` | `LineItem, SummaryCard, FlagsCard, InternalView, OutputCard` |
| `_app_inline.txt` | `App` root component + LocalStorage constants + STATUS_TONE + bottom of CSS tail |
| `__template.json` | Full HTML including all `@font-face` declarations (Bodoni Moda, Poppins) + complete CSS block 2 |
| `dd277869-8647-4589-a047-a1ef83b124df.js` | React (react.development.js) — vendor, ignore |
| `1b42706e-7721-44f9-b7a2-8f2fd21a3987.js` | ReactDOM — vendor, ignore |
| `e1ee9959-ab25-4cac-9203-dd037dd949a4.js` | Babel standalone (3 MB) — vendor, ignore |
