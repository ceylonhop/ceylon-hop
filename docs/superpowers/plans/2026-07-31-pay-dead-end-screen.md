# pay.html dead-end screen ("sailed off") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pay.html's two bland dead-end states (revised/unavailable) with one owner-approved 404-sibling screen: animated paper-boat island scene, pun headline, "Nothing has been charged", WhatsApp button.

**Architecture:** Front-end only, one file of product code (`pay.html`) plus one spec file (`web-tests/e2e/pay-page.spec.js`). Both dead-end render functions delegate to one shared `renderSailedOff()`. CSS + SVG live inline in pay.html per that page's convention; `ticket.css` (shared with manage.html) is untouched. Spec: `docs/superpowers/specs/2026-07-31-pay-dead-end-screen-design.md`.

**Tech Stack:** Static HTML/CSS/inline SVG, vanilla JS; Playwright (web-tests).

## Global Constraints

- One screen serves BOTH `revised` and `unavailable`; keep `renderRevised()`/`renderUnavailable()` as separate functions sharing markup (future split = copy change).
- Lead line must contain exactly the facts: **"Nothing has been charged."** + WhatsApp next step. Headline: **"This quote has sailed off somewhere sunny"**. Eyebrow: `quote · no longer active`.
- No quote data (name/route/total) may appear in the dead-end DOM — the API returns bare `{state}` and the page must not invent content.
- All animation inside `@media (prefers-reduced-motion: reduce){...{animation:none}}`.
- WhatsApp button = site's `.btn-wa` (solid `#0B7A44`) → `https://wa.me/94779669662`.
- Do not touch: `ticket.css`, `404.html`, `manage.html`, `site.css`, the `paid`/`payable` states, `waLine()`, header, error beacons.
- Branch `feat/pay-dead-end-screen` (contains the spec commit); gates: `web-tests npm run test:all` AND `cd api && npm run check` green before PR.

---

### Task 1: Failing web-tests for the new screen

**Files:**
- Modify: `web-tests/e2e/pay-page.spec.js:115-127` (replace the existing `revised and unavailable` test)

**Interfaces:**
- Consumes: existing `stubView(page, body)` helper and `PAGE` const in the same file.
- Produces: selectors Task 2 must satisfy — `.de-wrap`, `.de-eyebrow`, `h1.de-title`, `.de-lead`, `a.btn-wa`, `svg.de-art`.

- [ ] **Step 1: Replace the old dead-end test with the new assertions**

Replace lines 115–127 of `web-tests/e2e/pay-page.spec.js` (the whole `test('revised and unavailable: soft states, no button, nothing charged', …)` block) with:

```js
test('revised and unavailable share the sailed-off screen: facts, WhatsApp, no leak', async ({ page }) => {
  for (const state of ['revised', 'unavailable']) {
    await page.unrouteAll();
    await stubView(page, { state });
    await page.goto(PAGE);
    // The 404-sibling screen (spec 2026-07-31): eyebrow → pun headline → lead → WhatsApp.
    await expect(page.locator('.de-eyebrow')).toContainText('no longer active');
    await expect(page.locator('h1.de-title')).toContainText('This quote has sailed off somewhere sunny');
    await expect(page.locator('.de-lead')).toContainText('Nothing has been charged');
    await expect(page.locator('a.btn-wa')).toHaveAttribute('href', 'https://wa.me/94779669662');
    await expect(page.locator('svg.de-art')).toBeVisible(); // the boat scene
    await expect(page.locator('#paybtn')).toHaveCount(0);   // never re-offer Pay
    // Privacy: a dead-end must not leak quote data the API deliberately withholds.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('$');
    expect(body).not.toContain('LKR');
  }
});

test('sailed-off screen animation is guarded for reduced motion', async ({ page }) => {
  await stubView(page, { state: 'unavailable' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(PAGE);
  const anim = await page.locator('svg.de-art .sail').first()
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe('none');
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `cd web-tests && npx playwright test pay-page`
Expected: FAIL — `.de-eyebrow` not found (old `.st-badge` markup still renders).

- [ ] **Step 3: Commit**

```bash
git add web-tests/e2e/pay-page.spec.js
git commit -m "test(pay): dead-end states must render the sailed-off screen (red)"
```

### Task 2: Implement the screen in pay.html

**Files:**
- Modify: `pay.html` — (a) the page-specific `<style>` block, (b) `renderUnavailable()`/`renderRevised()` at lines ~77–87.

**Interfaces:**
- Consumes: existing `app` element, `waLine()` (kept, unchanged, appended after the screen as on every other state).
- Produces: the selectors Task 1 asserts (`.de-wrap`, `.de-eyebrow`, `h1.de-title`, `.de-lead`, `a.btn-wa`, `svg.de-art`, animation classes `.bob/.spin/.dash/.pin/.sail`).

- [ ] **Step 1: Add the dead-end CSS to pay.html's inline `<style>` block**

Append inside the existing `<style>` (after the `.hop-*` rules), before `</style>`:

```css
  /* ── dead-end screen (spec 2026-07-31): sibling of 404.html's island scene ── */
  .de-wrap{text-align:center;padding:18px 0 8px}
  .de-art{width:min(430px,86vw);height:auto;display:block;margin:0 auto 6px}
  .de-eyebrow{font-size:.68rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent-deep)}
  .de-title{font-family:var(--display);font-weight:800;font-size:clamp(1.7rem,7vw,2.2rem);line-height:1.08;letter-spacing:-.015em;color:var(--ink);margin:.3rem 0 .5rem}
  .de-lead{color:var(--ink-soft);font-size:.95rem;max-width:36ch;margin:0 auto}
  .de-cta{margin-top:20px}
  .de-cta .btn-wa{display:inline-block;background:#0B7A44;color:#fff;font-weight:700;border-radius:10px;padding:12px 22px;text-decoration:none}
  @keyframes de-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
  @keyframes de-spin{to{transform:rotate(360deg)}}
  @keyframes de-dash{to{stroke-dashoffset:-30}}
  @keyframes de-pin{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
  @keyframes de-sail{0%,100%{transform:translate(0,0) rotate(-2deg)}50%{transform:translate(7px,-5px) rotate(2.5deg)}}
  .de-art .bob{animation:de-bob 5.5s ease-in-out infinite}
  .de-art .spin{animation:de-spin 40s linear infinite;transform-box:fill-box;transform-origin:center}
  .de-art .dash{stroke-dasharray:6 9;animation:de-dash 2.6s linear infinite}
  .de-art .pin{animation:de-pin 3.4s ease-in-out infinite}
  .de-art .sail{animation:de-sail 4.6s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
  @media (prefers-reduced-motion:reduce){.de-art .bob,.de-art .spin,.de-art .dash,.de-art .pin,.de-art .sail{animation:none}}
```

- [ ] **Step 2: Replace the two render functions**

Replace the existing `renderUnavailable()` and `renderRevised()` bodies (pay.html lines ~77–87) with:

```js
  // One dead-end screen for both states (spec 2026-07-31, owner: "one option for now").
  // Sibling of 404.html's island scene. Two functions kept so a later revised-specific
  // screen ("a fresh link is on its way") is a copy change, not a refactor. No quote data
  // renders here — the API returns a bare {state} for dead ends, on purpose.
  function renderSailedOff(){
    app.innerHTML = '<div class="de-wrap">'
      + SAILED_OFF_ART
      + '<p class="de-eyebrow">quote &middot; no longer active</p>'
      + '<h1 class="de-title">This quote has sailed off somewhere sunny</h1>'
      + '<p class="de-lead"><strong>Nothing has been charged.</strong> Message us on <strong>WhatsApp</strong> and we&rsquo;ll get you moving again.</p>'
      + '<div class="de-cta"><a class="btn-wa" href="https://wa.me/94779669662">WhatsApp us</a></div>'
      + '</div>' + waLine();
  }
  function renderUnavailable(){ renderSailedOff(); }
  function renderRevised(){ renderSailedOff(); }
```

- [ ] **Step 3: Add the SVG constant**

Immediately above `renderSailedOff()`, add the approved scene verbatim (single-quoted JS string concatenation is error-prone for a 60-line SVG — use one template literal):

```js
  var SAILED_OFF_ART = `<svg class="de-art" viewBox="0 0 480 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A little paper boat sailing away from the shore while the coral map pin watches">
    <defs>
      <radialGradient id="deSky" cx="50%" cy="30%" r="80%"><stop offset="0%" stop-color="#fdfbf3"/><stop offset="100%" stop-color="#e7f4f0"/></radialGradient>
      <linearGradient id="deSea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a4ddd7"/><stop offset="100%" stop-color="#54c1ba"/></linearGradient>
      <linearGradient id="deLand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f4e7c8"/><stop offset="100%" stop-color="#e7d1a1"/></linearGradient>
    </defs>
    <rect width="480" height="300" fill="url(#deSky)"/>
    <g transform="translate(398,54)"><g class="spin">
      <circle r="19" fill="#f6b44c"/>
      <g stroke="#f6b44c" stroke-width="3" stroke-linecap="round">
        <line x1="0" y1="-26" x2="0" y2="-33"/><line x1="0" y1="26" x2="0" y2="33"/>
        <line x1="-26" y1="0" x2="-33" y2="0"/><line x1="26" y1="0" x2="33" y2="0"/>
        <line x1="-18.4" y1="-18.4" x2="-23.3" y2="-23.3"/><line x1="18.4" y1="18.4" x2="23.3" y2="23.3"/>
        <line x1="-18.4" y1="18.4" x2="-23.3" y2="23.3"/><line x1="18.4" y1="-18.4" x2="23.3" y2="-23.3"/>
      </g>
    </g></g>
    <g stroke="#6c6a6b" stroke-width="2.4" stroke-linecap="round" fill="none" opacity=".35">
      <path d="M262 74 q6 -7 12 0 q6 -7 12 0"/>
      <path d="M306 94 q5 -6 10 0 q5 -6 10 0"/>
    </g>
    <ellipse cx="250" cy="244" rx="280" ry="76" fill="url(#deSea)"/>
    <g stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none" opacity=".55">
      <path d="M228 234 q9 -6 18 0 t18 0"/>
      <path d="M330 254 q9 -6 18 0 t18 0"/>
      <path d="M262 276 q9 -6 18 0"/>
      <path class="dash" d="M186 244 q10 -7 20 0 t20 0 t20 0" stroke-width="2.6"/>
    </g>
    <g class="bob">
      <path d="M40 216 Q56 182 112 176 Q170 170 196 186 Q216 199 202 216 Q184 236 116 238 Q48 238 40 216 Z" fill="url(#deLand)" stroke="#d8c193" stroke-width="3"/>
      <ellipse cx="78" cy="220" rx="13" ry="5" fill="#8fce9f"/>
      <ellipse cx="166" cy="212" rx="11" ry="4.5" fill="#8fce9f"/>
      <path d="M74 198 q-8 -26 3 -46" stroke="#9a6b3f" stroke-width="7" stroke-linecap="round" fill="none"/>
      <g fill="#4bb08a">
        <ellipse cx="63" cy="146" rx="17" ry="6.5" transform="rotate(-24 63 146)"/>
        <ellipse cx="89" cy="148" rx="17" ry="6.5" transform="rotate(28 89 148)"/>
        <ellipse cx="72" cy="140" rx="15" ry="6" transform="rotate(-68 72 140)"/>
        <ellipse cx="84" cy="156" rx="15" ry="6" transform="rotate(60 84 156)"/>
      </g>
      <g class="pin" transform="translate(142,164)">
        <path d="M0 26 C-13 8 -15 -4 0 -12 C15 -4 13 8 0 26 Z" fill="#ef6a4a"/>
        <circle cx="0" cy="-1" r="7.5" fill="#fff"/>
        <text x="0" y="3" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-size="11" fill="#ef6a4a">?</text>
      </g>
    </g>
    <g transform="translate(312,212)"><g class="sail">
      <path d="M-22 6 L22 6 L13 18 L-13 18 Z" fill="#fffdf8" stroke="#d8c193" stroke-width="2"/>
      <path d="M-1 -20 L-1 4 L17 4 Z" fill="#fffdf8" stroke="#d8c193" stroke-width="1.8" stroke-dasharray="3 3"/>
      <line x1="3" y1="-6" x2="10" y2="-6" stroke="#d8c193" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="3" y1="-1" x2="12" y2="-1" stroke="#d8c193" stroke-width="1.6" stroke-linecap="round"/>
    </g></g>
  </svg>`;
```

- [ ] **Step 4: Run the pay-page suite to verify green**

Run: `cd web-tests && npx playwright test pay-page`
Expected: PASS — all pay-page tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add pay.html
git commit -m "feat(pay): dead-end states get the 404-sibling sailed-off screen (green)"
```

### Task 3: Full gates, visual check, PR

**Files:** none new.

- [ ] **Step 1: Full web-tests suite**

Run: `cd web-tests && npm run test:all`
Expected: unit + e2e pass (ambient flakes: re-run a failing spec in isolation before blaming the change).

- [ ] **Step 2: API gate**

Run: `cd api && npm run check`
Expected: typecheck + lint + 1510 tests pass (pay.html is served by the API in prod; opsUi/static specs must stay green).

- [ ] **Step 3: Visual check in the browser preview**

Serve the static root, open `/pay.html?t=x` with the view call stubbed unreachable (any garbage token → `unavailable`), and screenshot-compare against the approved mockup (`.superpowers/brainstorm/91040-1785542860/content/state-screen-v4.html`, right-hand state): scene renders, boat drifts, sun spins, headline/lead/button correct, and with OS reduced-motion the scene is static.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/pay-dead-end-screen
gh pr create --base main --title "pay.html: dead-end states get the 404-sibling 'sailed off' screen" \
  --body "Spec + plan in docs/superpowers/{specs,plans}/2026-07-31-pay-dead-end-screen*. One screen for revised+unavailable (owner call). Front-end only; no API change; ticket.css untouched. Red→green evidence in commits."
```

## Self-Review

- Spec coverage: layout 5 elements → Task 2 steps 1–3; both states share screen → Task 2 step 2; privacy/no-leak → Task 1 `$`/`LKR` assertions; reduced motion → Task 1 test 2 + Task 2 CSS; ticket.css untouched → constraint + no ticket.css edits anywhere; testing section → Tasks 1 & 3. No gaps.
- Placeholders: none — full test code, CSS, JS, SVG included.
- Type consistency: selectors `.de-*`, classes `.bob/.spin/.dash/.pin/.sail` identical across Task 1 assertions and Task 2 markup/CSS; `SAILED_OFF_ART` defined before use.
