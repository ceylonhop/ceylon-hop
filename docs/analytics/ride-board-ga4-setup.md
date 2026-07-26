# Ride Board → GA4 setup

The site code already pushes every event below to `dataLayer` (shipped 2026-07-26, PR #183).
Nothing reaches GA4 until GTM forwards it — that is what this does.

- **GTM container:** `GTM-NL6K22CM`
- **GA4 property:** `G-XEW62ZD7B3`
- **Import file:** [`gtm-ride-board-funnel.json`](gtm-ride-board-funnel.json) — 15 variables, 7 triggers, 7 tags

---

## 1. Import the container file

GTM → **Admin → Import Container** → choose `gtm-ride-board-funnel.json`.

- Workspace: **New** (e.g. `ride-board-funnel`)
- Import option: **MERGE**, and **"Rename conflicting tags, triggers and variables"**

> **Do not choose Overwrite.** Overwrite replaces the entire container and would delete
> every existing tag. Merge only adds. The account/container ids in the file are
> placeholders (`0`) — GTM remaps them on import; that is expected.

Review the diff GTM shows you before confirming.

## 2. What the import creates

| Tag | Trigger | Params sent |
|---|---|---|
| `GA4 - view_item_list (ride board)` | `view_item_list` **where `item_list_id = ride_board`** | `item_list_id`, `item_list_name`, `board_count`, `filter_from`, `filter_when` |
| `GA4 - select_item (ride board)` | `select_item` **where `item_list_id = ride_board`** | `item_list_id`, `item_id`, `item_name`, `seats_committed`, `seats_needed` |
| `GA4 - begin_checkout (ride board)` | `begin_checkout` **where `item_list_id = ride_board`** | `item_list_id`, `flow`, `item_id`, `currency`, `value` |
| `GA4 - login (ride board)` | `login` | `method`, `item_list_id` |
| `GA4 - join_ride (ride board)` | `join_ride` | + `seats_committed`, `seats_needed`, `van_runs`, `value` |
| `GA4 - create_ride_list (ride board)` | `create_ride_list` | same as `join_ride` |
| `GA4 - scratch_ride (ride board)` | `scratch_ride` | `item_list_id`, `item_id`, `broke_threshold` |

**Why the first three are scoped.** `view_item_list`, `select_item` and `begin_checkout` are
GA4-standard names that `search.js`, `plan.js` and `booking.js` also fire. Their board tags
are filtered on `item_list_id = ride_board` so they can't double-fire on non-board events.
The site-wide versions of those events are Phase 0's job, not this file's — see
`docs/superpowers/plans/2026-07-05-analytics-funnel-phase0.md`.

All tags are set to require `analytics_storage` consent.

## 3. Prerequisite: a GA4 config tag

Each tag sets `measurementIdOverride`, so it will send even without a config tag — but if the
container has **no** GA4 Configuration / Google Tag firing on Consent Initialization, add one
for `G-XEW62ZD7B3` first. Otherwise session and user attribution will be wrong.

## 4. GA4 — register custom dimensions (do this FIRST)

*Admin → Custom definitions → Create custom dimension*, **event-scoped**, one per parameter:

| Dimension | Parameter | Why it matters |
|---|---|---|
| Van runs | `van_runs` | the join that tipped a van over its threshold — the money moment |
| Broke threshold | `broke_threshold` | a scratch that dropped a viable van back below the line |
| Flow | `flow` | `join_list` vs `create_list` |
| Filter from / when | `filter_from`, `filter_when` | which corridors people actually browse |
| Seats committed / needed | `seats_committed`, `seats_needed` | how close vans get before dying |
| Board count | `board_count` | **an empty board is the single most useful signal here** |

> GA4 does **not backfill**. Any parameter not registered is unqueryable for every day before
> you register it. Do this before the traffic arrives, not after.

## 5. GA4 — mark key events

*Admin → Events → mark as key event*: `join_ride`, `create_ride_list`.

## 6. Build the funnel

*Explore → Funnel exploration*, open funnel:

`view_item_list` → `select_item` → `begin_checkout` → `login` → `join_ride`

Sign-in sits between wanting a seat and having one, so `login → join_ride` is the drop-off
to watch first.

## 7. Verify before publishing

1. GTM **Preview** (Tag Assistant) against `https://prod.ceylonhop.com/board.html`
2. **Accept the cookie banner** — Consent Mode defaults `analytics_storage: denied`, so
   nothing fires until you do. This is the most common "my tags don't work" cause here.
3. Walk it: load the board → open a van → click join → sign in → add your name → scratch off
4. Each step should show its tag fired, with parameters populated
5. Confirm in GA4 *Realtime*, then **Submit / Publish** the GTM workspace

---

## Known limitations

**Built-in ecommerce reports will stay empty.** `board.js` emits `item_id` / `item_name` as
flat parameters, not GA4's expected `items[]` array. Events record fine and the funnel above
works, but GA4's ecommerce reporting needs `items[]`. Fixable either in GTM (build the array
in a Custom JavaScript variable) or in `board.js`.

**No `purchase` event, deliberately.** A board join is a card *held*, not money taken — the
charge happens at cutoff, server-side, in `runRideBoardCutoff`. Firing `purchase` at join
would inflate revenue by every van that never runs. If you want confirmed-van revenue in GA4
it needs a server-side Measurement Protocol call from the cutoff sweep, not a browser event.

**`chIsProd()` does not match the board's own domain.** It tests `/^(www\.)?ceylonhop\.com$/`
(`analytics.js:13`) but the board is live on `prod.ceylonhop.com`. Board events are not gated
on it so they fire correctly — but `purchase` in `booking.js` **is** gated on it, which means
purchase has never fired on the new stack. Pre-existing; logged separately.
