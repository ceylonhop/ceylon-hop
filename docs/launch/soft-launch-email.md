# Soft-launch email to past customers (draft, 2026-09-23)

**Purpose:** a warm, forgiving audience tests the new site before the public launch. The
ask is feedback, not sales, with a small thank-you for the next ride.

**Who gets it:** rows in `customers` with `marketing_opt_in = true`, deduped on
`person_key` (one email per human). Past WordPress customers come from the owner's
2026-08-27 sales export; only those who opted in there. EU/UK recipients without a recorded
opt-in do not get this one (it is marketing, not transactional).

**Send from:** the owner's normal Gmail / the transactional sender, BCC in batches of ≤50,
or a free Mailchimp/Brevo tier for the unsubscribe link. Not from the API.

---

**Subject options** (pick one, A/B if the tool allows):
- You helped build this: the new Ceylon Hop
- The new ceylonhop.com is live, and we'd like your honest opinion
- Same drivers, new site: see any Sri Lanka transfer price in 10 seconds

**Body**

Hi {{first_name}},

You travelled with Ceylon Hop a while ago, so you're one of the first people we're telling.

We rebuilt ceylonhop.com from scratch. The thing we kept hearing from travellers was that
sorting transport in Sri Lanka means messaging five people and getting five different
prices. So now the price is just there:

- **Any two places, priced instantly.** Type where you're going and see the private transfer
  price before you talk to anyone. Pay online, and a vetted driver turns up.
  → ceylonhop.com/search.html
- **The Ride Board.** Sri Lanka's first shared-taxi board. Post the ride you need, other
  travellers join, everyone pays a seat instead of a whole car. Wednesday and Saturday
  scheduled seats still run too.
  → ceylonhop.com/board.html
- **Plan a whole trip** and see what each leg costs, not just the total.
  → ceylonhop.com/plan.html

It's new, and we know some corners are still rough. That's why we're asking you first. If
anything is confusing, slow, or just wrong, reply to this email and tell us. Blunt is fine.
We read every reply.

And when you're next in Sri Lanka, or a friend is, reply with "friend" and we'll take 10%
off the first ride booked through the new site. Same drivers, same WhatsApp, same team.

Thank you for riding with us the first time round.

Roshen
Ceylon Hop · WhatsApp +94 77 966 9662 · ceylonhop.com

---

**Follow-up (5 days later, only to non-openers):** subject "Two minutes of your time?",
body = three lines: the search link, the board link, the feedback ask.

**Track:** GA4 source `email` / medium `soft-launch` via UTM on every link, e.g.
`?utm_source=email&utm_medium=soft-launch&utm_campaign=rebuild-2026-10`.
