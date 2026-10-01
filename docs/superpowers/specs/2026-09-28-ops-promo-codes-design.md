# Promo codes on the ops Rates page — design

**Date:** 2026-09-28 · **Status:** design approved by the owner in chat (2026-09-28); spec for
review · **Read from:** `origin/main` @ `4a70398f`.
**Phase:** §10.2 of `2026-09-14-promo-codes-design.md` (the ops screen). **Mockup:**
`2026-09-28-ops-promo-codes-mockup.html`, next to this file.

## 1. Problem

Promo codes exist on the backend (#618, live on prod behind `PROMO_CODES_ENABLED`), but the ops tool
has no screen for them. Today a code can only be made by pasting a `fetch()` into the browser
console while signed in to ops. That is how the staging test code was made on 2026-09-28. The owner
wants to do it from the **Rates** page instead.

## 2. Owner decisions (2026-09-28, chat)

1. A **Promo codes** section on the Rates page, below Hot zones. It is not a separate menu item.
2. The founder can:
   - create a code, setting its **% off**, **number of uses**, **start** (optional) and **expiry**;
   - see how many times each code has been used;
   - end a code early.
3. **% off only.** The backend also accepts fixed-amount codes. The form doesn't offer them; they can
   be added later without a backend change.
4. Not in this release: the list of bookings that used a code. The backend already serves it:
   `GET /admin/promo-codes/:id` returns `bookings`.

## 3. What the backend already does (read on `origin/main` @ `4a70398f`)

No API, schema or config change is needed.

- **`GET /admin/promo-codes`** → `{ codes: [...] }`, in the order `promoCodes.list()` returns them.
  Each code has:
  - `{ id, code, method, value, startsAt, expiresAt, maxUses, active, createdBy, createdAt, updatedBy, updatedAt }`;
  - `uses: { paid, held, remaining }` and `worksNow` (`api/src/routes/promoCodes.ts:17-31, 61-73`).
- **`POST /admin/promo-codes`** with `{ code, method, value, startsAt?, expiresAt, maxUses }`
  (`promoCode.ts:101-128`):
  - `code` is trimmed, upper-cased and must match `^[A-Z0-9-]{3,32}$` (`promoCode.ts:11, 47-51`);
  - a percentage `value` is **basis points**, 100–3000 (1%–30%);
  - `expiresAt` must be after `startsAt`, and `maxUses` must be at least 1.
- **POST responses** (`promoCodes.ts:76-91`):
  - `201` with the code;
  - `409 code_taken`;
  - `400 invalid_request` with `details.fieldErrors`;
  - `403 promo_codes_disabled` while the server's `PROMO_CODES_ENABLED` is off.
- **`PATCH /admin/promo-codes/:id`** accepts only `expiresAt`, `maxUses` and `active`
  (`promoCode.ts:131-138`). The code and its % can never change after creation, which protects
  bookings already made with it.
- **Access:** every route needs the ops session plus the `promo_codes:manage` capability (founder
  only, `api/src/lib/opsAuth.ts:31`) and passes a same-origin CSRF check (`promoCodes.ts:46-58`).
- **Ending a code** (`active: false`) refuses new uses immediately. A booking still inside its
  2-hour hold can go on to pay at the discounted price. Once the hold lapses, the checkout re-check
  refuses the ended code (`api/src/db/bookingRepo.ts:573-585`).
- **Timing:** start is inclusive and expiry is exclusive (`promoCode.ts:54-62`).

## 4. What the founder sees

### 4.1 Placement and access

- A **Promo codes** panel in `renderRatesPage()` (`ops-ui.html:8020-8044`), after
  `renderHotZonesPanel()`, in the same card and with the same heading style.
- It shows only when the signed-in role has `promo_codes:manage`, which is the founder today.
  Other roles never see it and never call the API.

### 4.2 The list

One row per code, **newest first**. The client sorts on `createdAt`, so the page doesn't depend on
the API's order.

| Column | Shows |
|---|---|
| Code | `ROSHEN-7KQ2`, in the mono font |
| Off | `10%` (`value / 100`) |
| Uses | `3 paid · 1 held · 16 left of 20` |
| Starts | `1 Oct` or "Now" when `startsAt` is null |
| Ends | the last day it works, e.g. `31 Oct` (§4.4) |
| Status | a chip, as below |
| | **Edit** · **End now** (or **Turn back on** for an Ended code) |

The Status chip is decided in this order, first match wins:
1. **Ended** when `active` is false.
2. **Expired** when now is at or after `expiresAt`.
3. **Used up** when `uses.remaining` is 0.
4. **Starts later** when now is before `startsAt`.
5. **Active** otherwise.

A small line under the heading explains "held": *"Held = an unpaid booking is reserving a use for up
to 2 hours."*

If there are no codes, the list says so: *"No promo codes yet."*

### 4.3 Create

A form under the list, with uncontrolled inputs as in the hot-zones panel (`ops-ui.html:7579-7585`):

| Field | Input | Rule (checked in the page before sending; the server checks again) |
|---|---|---|
| Code | text, shown upper-case, max 32 | 3–32 of A–Z, 0–9, `-` |
| | **Suggest** button | fills the field with `CH-` + 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0/O/1/I`), made with `crypto.getRandomValues` |
| % off | number, whole, 1–30 | sent as `value = pct × 100`, `method: 'percentage'` |
| Uses | number, whole, ≥ 1 | `maxUses` |
| Starts | date, optional | left empty, the code works immediately |
| Ends | date, required | must be today or later, and on or after Starts |

The **Create code** button sends the POST and reloads the list. It shows a toast "Code ROSHEN-7KQ2
created" (the `ratesToast` pattern) and clears the form.

### 4.4 Dates are Sri Lanka days

The founder picks days, not instants. The page converts:
- **Starts** `2026-10-01` → `startsAt: "2026-10-01T00:00:00+05:30"`.
- **Ends** `2026-10-31` → `expiresAt: "2026-11-01T00:00:00+05:30"`: the code works through the whole
  of 31 Oct, Sri Lanka time.
- The list shows expiry the same way, as the last working day: `expiresAt` minus one day,
  formatted in `Asia/Colombo`.

### 4.5 Edit and end

- **Edit** turns the row into two inputs, **Ends** (date) and **Uses** (number), with **Save** and
  **Cancel**. It sends a PATCH with only the fields that changed.
- If the new Uses is below `paid + held`, a `window.confirm` asks first: *"3 uses are already paid or
  held. Set the limit to 2 anyway? No new bookings will be able to use it."*
- **End now** asks `window.confirm`:
  *"End ROSHEN-7KQ2 now? It stops working for new bookings immediately. Bookings already holding it
  (for up to 2 hours) can still pay at the discounted price."*
  It then sends `PATCH { active: false }`.
- **Turn back on** (Ended rows only) sends `PATCH { active: true }` without a confirm. It is the undo
  for a mistaken End now.

### 4.6 Messages

| Situation | Shown |
|---|---|
| `403 promo_codes_disabled` on create | A banner in the panel: *"Promo codes are switched off on this server, so new codes can't be created here. Existing codes still show."* The form stays, disabled. |
| `409 code_taken` | Under the Code field: *"That code already exists."* |
| `400 invalid_request` | The first field error from `details.fieldErrors`, else *"Check the values."* |
| List load fails | *"Couldn't load promo codes."* and a **Retry** button |
| Save/End/Turn back on fails | Toast *"Couldn't save — try again."*; the row keeps its old values |

The banner is learned from the first refused create. The list endpoint doesn't report the flag,
and adding that would be an API change this design avoids.

## 5. How it's built

All in `api/src/routes/ops-ui.html`, inside the QuoteView module next to the hot-zones code:

- **State:** `promoCodes` (array or null), `promoLoadFailed`, `promoBusy`, `promoEditId`,
  `promoDisabled` (set by a `promo_codes_disabled` refusal), `promoFieldError`.
- **`loadPromoCodes()`** is called from `showRates()` on arrival, beside `loadRates()` and
  `loadHotZones()` (`ops-ui.html:8121-8133`), and only when the role has `promo_codes:manage`.
- **`renderPromoCodesPanel()`** returns the panel's HTML. `renderRatesPage()` morphs it in like the
  other panels. The create form is excluded from morphing while it has typed values, the same guard
  the rates form uses (`ops-ui.html:8032-8036`), so a list reload can't wipe a half-typed code.
- **Actions:** new `data-action` branches in the Rates page's click delegate
  (`ops-ui.html:8147-8170`): `promoSuggest`, `promoCreate`, `promoEditStart`, `promoEditCancel`,
  `promoEditSave`, `promoEnd`, `promoReactivate` and `promoRetry`. Every async call follows the
  existing pattern: set busy, re-render, await, clear busy, reload the list or toast the failure.
  Errors go to `window.opsReportError`.
- **Helpers** (pure, so the tests can reach them):
  - `promoStatus(code, now)`
  - `promoDayToStartIso(yyyyMmDd)`
  - `promoDayToExpiryIso(yyyyMmDd)`
  - `promoExpiryDay(iso)`
  - `promoSuggestCode()`
- **Styles:** reuse the panel, row, input and button classes the hot-zones panel uses. The only new
  CSS is the status chips, built on the existing `--ok/--wait/--idle/--alert` tokens.

## 6. Testing

`web-tests/e2e/ops-promo-codes.spec.js`, offline, stubbing the API as `ops-rates-page.spec.js`
does:

- **Access:** a founder (with `promo_codes:manage`) sees the panel. A role without the capability
  sees no panel, and no `/admin/promo-codes` request is made.
- **List:** codes render newest first with the right discount, uses line, dates and status. There is
  one code per status: Active, Starts later, Expired, Used up, Ended.
- **Create:**
  - the POST body is `{ code: 'SPRING-26', method: 'percentage', value: 1000, maxUses: 20, startsAt: '2026-10-01T00:00:00+05:30', expiresAt: '2026-11-01T00:00:00+05:30' }`;
  - the list reloads and a toast shows;
  - leaving Starts empty sends no `startsAt`.
- **Validation:** a bad code shape, 0% or 31%, 0 uses, or Ends before Starts each show a message
  and send nothing.
- **Suggest** fills a code matching `^CH-[A-HJ-NP-Z2-9]{6}$`.
- **Edit:** sends only the changed fields. Lowering Uses below paid + held asks first.
- **End now:** confirm, then `PATCH { active: false }`. Cancelling the confirm sends nothing.
  **Turn back on** sends `{ active: true }`.
- **Refusals:** `promo_codes_disabled` shows the banner and disables the form. `code_taken` shows the
  field message.
- **A reload mid-typing** keeps the typed code.
- **375px:** the panel fits without sideways scrolling.

Gate: `npm --prefix web-tests run test:all` and `cd api && npm run check`, both green.

## 7. Out of scope

- Fixed-amount codes in the form.
- A list of the bookings that used a code (§2.4).
- Deleting codes. The backend has no delete, and ending a code is the way to stop one.
- Any API, schema, config or `PROMO_CODES_ENABLED` change.
- The booking-page code field. That is #858, a separate PR.

## 8. Rollout

- One PR touching `ops-ui.html` and the new e2e spec. `ops-ui.html` is shared with other work in
  flight, so merge it smallest-first.
- The ops UI is served by the API: merging to `main` puts it on **staging**, and the
  `main → production` promote puts it on **prod**.
- On prod, the list works at once, but creating a code shows the switched-off banner until
  `PROMO_CODES_ENABLED=1` is set there. That is the go-live step in the booking-field spec (§8 of
  `2026-09-24-promo-code-field-design.md`).
