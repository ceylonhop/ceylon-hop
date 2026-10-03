-- Route report (2026-10-03): paid bookings by known town → known town, and by region.
-- Read-only. Run in the Supabase SQL editor. Same place rule as
-- api/src/services/analytics/knownPlace.ts (the alias table below is parity-tested against it).
-- Excludes the owner's test bookings, cancelled and refunded ones, and anything never paid.
-- `collected_usd` = money taken online; `booked_value_usd` = booking totals. The gap is
-- deposits still owed (`deposit_bookings`), which GA4 also never sees as revenue.
with alias(alias, town, region) as (values
  ('adam''s peak', 'Adam''s Peak', 'Hill country'),
  ('ahangama', 'Ahangama', 'South coast'),
  ('anuradhapura', 'Anuradhapura', 'Cultural triangle'),
  ('arugam bay', 'Arugam Bay', 'East coast'),
  ('bentota', 'Bentota', 'South coast'),
  ('colombo airport (cmb)', 'Colombo Airport (CMB)', 'Airport & Negombo'),
  ('colombo airport', 'Colombo Airport (CMB)', 'Airport & Negombo'),
  ('colombo city', 'Colombo City', 'Colombo'),
  ('colombo', 'Colombo City', 'Colombo'),
  ('dambulla', 'Dambulla', 'Cultural triangle'),
  ('ella', 'Ella', 'Hill country'),
  ('galle', 'Galle', 'South coast'),
  ('habarana', 'Habarana', 'Cultural triangle'),
  ('haputale', 'Haputale', 'Hill country'),
  ('hatton', 'Hatton', 'Hill country'),
  ('hikkaduwa', 'Hikkaduwa', 'South coast'),
  ('hiriketiya', 'Hiriketiya', 'South coast'),
  ('horton plains', 'Horton Plains', 'Hill country'),
  ('jaffna', 'Jaffna', 'North & west'),
  ('kalpitiya', 'Kalpitiya', 'North & west'),
  ('kandy', 'Kandy', 'Hill country'),
  ('kitulgala', 'Kitulgala', 'Hill country'),
  ('mirissa', 'Mirissa', 'South coast'),
  ('nanu oya', 'Nanu Oya', 'Hill country'),
  ('negombo', 'Negombo', 'Airport & Negombo'),
  ('nilaveli beach', 'Nilaveli Beach', 'East coast'),
  ('nilaveli', 'Nilaveli', 'East coast'),
  ('nuwara eliya', 'Nuwara Eliya', 'Hill country'),
  ('pasikudah', 'Pasikudah', 'East coast'),
  ('polonnaruwa', 'Polonnaruwa', 'Cultural triangle'),
  ('sigiriya / dambulla', 'Sigiriya / Dambulla', 'Cultural triangle'),
  ('sigiriya', 'Sigiriya / Dambulla', 'Cultural triangle'),
  ('tangalle', 'Tangalle', 'South coast'),
  ('thanthirimale', 'Thanthirimale', 'Cultural triangle'),
  ('tissamaharama', 'Tissamaharama', 'Safari south'),
  ('trincomalee', 'Trincomalee', 'East coast'),
  ('udawalawe', 'Udawalawe', 'Safari south'),
  ('unawatuna', 'Unawatuna', 'South coast'),
  ('weligama', 'Weligama', 'South coast'),
  ('wilpattu', 'Wilpattu', 'North & west'),
  ('yala', 'Yala', 'Safari south')
),
booking as (
  select
    b.id, b.reference, b.mode, b.channel, b.created_at, b.total,
    coalesce(b.amount_due_now, b.total) as due_now,
    coalesce(
      (select bl.from_place from booking_legs bl
        where bl.booking_id = b.id and bl.removed_at is null order by bl.seq asc limit 1),
      tr.from_place, sr.from_place, co.from_place) as pickup_text,
    coalesce(
      (select bl.to_place from booking_legs bl
        where bl.booking_id = b.id and bl.removed_at is null order by bl.seq desc limit 1),
      tr.to_place, sr.to_place, co.to_place) as dropoff_text
  from bookings b
  join customers c              on c.id = b.customer_id
  left join transfer_request tr on tr.booking_id = b.id
  left join shared_request  sr  on sr.booking_id = b.id
  left join corridor        co  on co.id = sr.corridor_id
  where b.created_at >= date '2026-09-01'                     -- change the start date here
    and b.status not in ('cancelled', 'refunded')
    and lower(btrim(c.email)) not in ('roshenw@gmail.com', 'roshen@ceylonhop.com')
    and exists (select 1 from payments p where p.booking_id = b.id and p.status = 'succeeded')
),
ends as (
  select id, 'pickup' as side, coalesce(pickup_text, '') as place from booking
  union all
  select id, 'dropoff', coalesce(dropoff_text, '') from booking
),
tok as (   -- knownPlace.ts token(): whole string (priority highest), then comma parts, later = higher
  select e.id, e.side, s.prio,
    btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      lower(btrim(s.part)), '\s+', ' ', 'g'),
      ',?\s*sri lanka$', ''),
      '^\d{4,6}\s+|\s+\d{4,6}$', '', 'g'),
      '^colombo\s+\d{1,2}$', 'colombo')) as token,
    (s.prio = 1000000) as whole
  from ends e
  cross join lateral (
    select e.place as part, 1000000 as prio
    union all
    select x.p, x.ord::int from regexp_split_to_table(e.place, ',') with ordinality as x(p, ord)
  ) s
),
matched as (
  select distinct on (t.id, t.side) t.id, t.side, a.town, a.region, t.whole
  from tok t join alias a on a.alias = t.token
  order by t.id, t.side, t.prio desc
),
place as (
  select e.id, e.side,
    case when e.place ~* '(airport|cmb|katunayake)' then 'Colombo Airport (CMB)' else coalesce(m.town, 'Other') end as town,
    case when e.place ~* '(airport|cmb|katunayake)' then 'Airport & Negombo' else coalesce(m.region, 'Other') end as region
  from ends e
  left join matched m on m.id = e.id and m.side = e.side
),
money as (
  select bk.id,
    coalesce((select sum(p.amount) from payments p
               where p.booking_id = bk.id and p.status = 'succeeded'), 0)
  - coalesce((select sum(f.amount_cents) from refunds f
               where f.booking_id = bk.id and f.status in ('manual_confirmed', 'api_confirmed')), 0)
      as collected_cents
  from booking bk
)
select
  p1.town   || ' → ' || p2.town   as route,
  p1.region || ' → ' || p2.region as region_route,
  count(*)                                              as bookings,
  count(*) filter (where bk.mode = 'single')            as transfers,
  count(*) filter (where bk.mode = 'shared')            as shared_seats,
  count(*) filter (where bk.mode = 'trip')              as trips,
  count(*) filter (where bk.channel = 'website')        as website,
  count(*) filter (where bk.channel = 'whatsapp')       as whatsapp,
  count(*) filter (where bk.due_now < bk.total)         as deposit_bookings,
  round(sum(m.collected_cents) / 100.0, 2)              as collected_usd,
  round(sum(bk.total) / 100.0, 2)                       as booked_value_usd,
  round(avg(bk.total) / 100.0, 2)                       as avg_booking_usd,
  string_agg(bk.reference, ', ' order by bk.created_at desc) as refs
from booking bk
join place p1 on p1.id = bk.id and p1.side = 'pickup'
join place p2 on p2.id = bk.id and p2.side = 'dropoff'
join money m  on m.id  = bk.id
group by 1, 2
order by booked_value_usd desc, bookings desc;
