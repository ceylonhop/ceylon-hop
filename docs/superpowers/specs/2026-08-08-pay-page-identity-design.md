# The pay page must not let a visitor become the customer — design

**Date:** 2026-08-08
**Status:** owner-reported defect on live records; fix designed and implemented in the same PR

## 1. What happened

Four real customers are recorded in production under the owner's identity:

| booking | recorded as | the quote actually says |
| --- | --- | --- |
| CH-MNSQD | Frank **Weliwatta** · roshen@ceylonhop.com | Frank · **+31** 641256927 |
| CH-JTHDE | Sil **Weliwatta** · roshen@ceylonhop.com | Sil · **+39** 339 654 0511 |
| CH-XKZL3 | Anushri **Weliwatta** · roshen@ceylonhop.com | Anushri · **+65** 8128 3191 |
| CH-CQDMQ | Ana **Weliwatta** · roshen@ceylonhop.com | Ana · **+351** 963 347 046 |

All four carry a `pending` payment with **zero** `payment_events` — the signature of a checkout
abandoned before PayHere ever replied (`docs/known-bugs.md`, and
[[ceylon-hop-iframe-checkout-defect]]).

**The owner did not type his name.** That is the fact that dissolves every other theory: the pay
page's surname field is **not required in the ops UI**, and he has no memory of filling it. The
browser did.

## 2. Why the browser could

`prefillFor()` (`api/src/routes/quotePay.ts`) fills the form from the quote. An ops quote captures
**one** contact field, and for these four it held a phone number, so:

```
firstName: 'Frank'     ← from customerName
lastName:  ''          ← customerName has no second word
email:     ''          ← the contact is a phone, not an email
whatsapp:  '+31 …'
```

Two empty boxes. And both are labelled for a password manager to fill:

```html
<input id="f-lastName" autocomplete="family-name">
<input id="f-email"    autocomplete="email">
```

Open that link in your own browser and Chrome offers your saved identity for exactly those two
fields. One tap writes **Weliwatta** and **roshen@ceylonhop.com** into a stranger's booking form.

`CustomerInput` requires `lastName` (`min(1)`), so a blank surname would have been **rejected**.
It could not have stayed empty. Something had to fill it — which is why the empty required box is
the root cause, not a detail.

`POST /quotes/pay/start` then does what it is designed to do: creates the booking from the
submitted form and stamps `convertedBookingId` on the customer's quote.

## 3. What is and is not damaged

**Bounded.** `refreshPayerDetails` rewrites the customer's name, email and phone when a later payer
submits, so if the real customer eventually pays, the record corrects itself.

**Not harmless.** Until then the ops queue shows the wrong person, and any customer email for that
booking is addressed to the owner. Four live bookings, all "Awaiting payment" — which is exactly
how a customer who was never reachable would look.

## 4. The fix

Four changes, smallest first. Each stands alone; together they close the path at every level.

### 4.1 The surname stops being required

`lastName` becomes optional on the customer input. It is already optional in the ops quote form, so
this is the two ends agreeing. An empty box that *must* be filled is what turned autofill from a
convenience into a data-corruption vector.

Downstream, a customer is displayed as `[first, last].filter(Boolean).join(' ')` — already the
shape used elsewhere, so a missing surname renders as just the first name rather than a stray space.

### 4.2 The form stops advertising itself to password managers

`autocomplete="off"` on the identity fields, plus field `name`s Chrome does not recognise. `off`
alone is ignored by Chrome on fields it has classified, which is why both are needed.

This is the customer's own device in the normal case, and losing autofill there is a small cost.
It is not a small cost to have staff silently overwrite a customer's identity.

### 4.3 Looking at a link cannot create a booking

`?preview=1` renders the page exactly as the customer sees it, with the submit disabled and a
plain banner saying so. The ops "Payment link" control gains a **Preview** action that opens it.

This is the fix that addresses the actual behaviour — wanting to see what the customer sees — and
it removes the reason to fill the form at all. It is deliberately client-side only: a preview that
cannot submit needs no server trust, and the server guard below covers anyone who forges the flag
away.

### 4.4 A staff address is never a customer address

`/quotes/pay/start` refuses a submission whose email belongs to an ops user, with a message naming
the reason. Belt and braces: it catches this exact failure even if the preview is bypassed, the
autocomplete attribute is lost in a future edit, or someone types the address by hand.

`OPS_USERS` is already parsed for auth, so the list is in hand.

## 4a. Critique of the above, before building it

Written, then argued with. Four things the design got wrong or overclaimed.

**1. §4.1 does not prevent autofill, and the spec implied it did.** Chrome fills empty fields
whether or not they are required. Making the surname optional removes the *forcing function* —
the operator no longer has to accept a suggestion to get past the box — but the box is still there
and still offered. §4.1 is a correctness fix and a de-risking; it is not the prevention.

**2. §4.2 is mitigation, not prevention, and cannot be more than that.** Chrome deliberately
ignores `autocomplete="off"` on fields it has classified, and it classifies from `id`, `name`,
`label` and placeholder together. `id="f-lastName"` beside a label reading "Last name" is a strong
signal that no attribute reliably suppresses. Worth doing — it stops the most eager fills — but a
design that *relies* on it is a design that will be wrong again.

**3. §4.4 would refuse a legitimate booking.** The owner booking a trip for himself, or for family,
submits a `ceylonhop.com` address truthfully. A flat ban on staff addresses breaks that, and the
operator hits a wall with no way through. **Revised:** refuse only when the address would
*contradict* the quote — i.e. the quote's own contact is a different person's. A quote raised
against `roshen@ceylonhop.com` may be paid by `roshen@ceylonhop.com`.

**4. The deeper fix is one the spec avoided.** `/start` stamps `convertedBookingId` on the quote
**before any money moves**, which is what binds a stranger's submission to the customer's quote. If
that stamp waited for settlement, a preview submission would leave a stray booking but the
customer's quote would stay clean. That is probably the right design — and it reaches the resume
path, `quoteOutcome`, and `findByConvertedBookingId`. It is not a change to make unattended and
untested against a live payment. **Recorded, not built.**

**5. Nothing detects a recurrence.** If §4.2 is defeated and §4.3 is bypassed, this fails exactly
as it did this time: silently, discovered weeks later by eye. A recurrence check belongs with the
fix, not after it.

## 4b. What is actually built here

§4.1 and §4.2 as written; §4.4 **as revised in 4a.3**; plus a recurrence guard from 4a.5.

**§4.3 (preview mode) is proposed, not built.** It adds an affordance the owner has not asked for
and cannot approve tonight, and the defect is closed without it. Left as the obvious next step.

## 5. Not in this change

- **The four production records.** They need the real surnames and emails, which only the owner
  has. Correcting them by guesswork would replace one wrong identity with another. Prepared as a
  checklist, not run.
- **Per-leg dates through the conversion** (`docs/known-bugs.md`, 2026-07-30). A separate defect on
  the same route; bundling it would put a schema-shaped change in a data-integrity fix.
- **Contact as phone / email / handle.** The owner asked for it, and `4.1` is its first step. The
  rest needs a decision about what happens to the ten notification senders when there is no address
  — worth its own spec rather than a guess made overnight.

## 6. Testing

- `prefillFor` returns an empty surname and email for a phone-only quote — the state that invited
  the autofill.
- `CustomerInput` accepts a missing surname and still rejects a missing first name.
- A customer with no surname renders as the first name alone, with no trailing space.
- The pay form carries `autocomplete="off"` on the identity fields.
- `?preview=1` disables submission; without it the page behaves exactly as today.
- `/start` refuses an ops-user email with a named error, and accepts an ordinary one.
- Every existing pay-link test stays green — the happy path must be untouched.

## 7. Rollout

No schema change, no migration. `main` → staging automatically; prod via the usual promote PR.
The four bad records are unaffected either way and wait for the owner.
