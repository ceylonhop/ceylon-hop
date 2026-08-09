-- Positive location identification (spec 2026-08-02).
--
-- Q-CEVGM priced Yala -> Colombo Airport at 78 km instead of ~286 and went out $90 under: the
-- stop was stored as Google's label "Yala, Sri Lanka", which missed the exact-match coords
-- catalog keyed on "yala", so the bare string reached Google's geocoder and resolved to a
-- village near Horana. Google reported ONE result with partial_match=false — it is confident
-- and wrong, so no guard keyed on its confidence can work.
--
-- The inverse rule instead: a location may only be priced once positively identified. This
-- table IS that identity record. Rows are keyed on the canonical string (canonPlace(): trim,
-- lowercase, collapse whitespace, drop a trailing ", sri lanka") because a stop string is
-- authored in five different front-end paths and they all converge on one server-side
-- distance call — keying here covers every path without touching the builder's state model.
CREATE TABLE IF NOT EXISTS place_resolutions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canon_key     text NOT NULL,
  display_name  text NOT NULL,
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  -- catalog: seeded below. confirmed: a human chose it. auto_linked: an independent geocode
  -- landed within 1 km of exactly one already-trusted row, so it names a place we already know.
  source        text NOT NULL DEFAULT 'confirmed',
  confirmed_by  text,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_resolutions_canon_key_unique UNIQUE (canon_key),
  CONSTRAINT place_resolutions_source_check CHECK (source IN ('catalog', 'confirmed', 'auto_linked'))
);

-- Seed the 21 catalog places from adapters/maps.ts COORDS, so nothing that priced correctly
-- yesterday needs a confirmation today. COORDS stays in code as the seed of record and as the
-- offline-estimate source; it simply stops being the only lookup.
INSERT INTO place_resolutions (canon_key, display_name, lat, lng, source) VALUES
  ('colombo airport (cmb)', 'Colombo Airport (CMB)', 7.18, 79.88, 'catalog'),
  ('colombo city',          'Colombo City',          6.93, 79.85, 'catalog'),
  ('negombo',               'Negombo',               7.21, 79.84, 'catalog'),
  ('bentota',               'Bentota',               6.42, 79.99, 'catalog'),
  ('hikkaduwa',             'Hikkaduwa',             6.14, 80.10, 'catalog'),
  ('galle',                 'Galle',                 6.03, 80.22, 'catalog'),
  ('weligama',              'Weligama',              5.97, 80.42, 'catalog'),
  ('mirissa',               'Mirissa',               5.95, 80.46, 'catalog'),
  ('kandy',                 'Kandy',                 7.29, 80.63, 'catalog'),
  ('nuwara eliya',          'Nuwara Eliya',          6.95, 80.79, 'catalog'),
  ('ella',                  'Ella',                  6.87, 81.05, 'catalog'),
  ('sigiriya / dambulla',   'Sigiriya / Dambulla',   7.95, 80.76, 'catalog'),
  ('anuradhapura',          'Anuradhapura',          8.31, 80.40, 'catalog'),
  ('yala',                  'Yala',                  6.37, 81.52, 'catalog'),
  ('arugam bay',            'Arugam Bay',            6.84, 81.84, 'catalog'),
  ('trincomalee',           'Trincomalee',           8.59, 81.21, 'catalog'),
  ('polonnaruwa',           'Polonnaruwa',           7.94, 81.00, 'catalog'),
  ('habarana',              'Habarana',              8.04, 80.75, 'catalog'),
  ('nilaveli beach',        'Nilaveli Beach',        8.70, 81.19, 'catalog'),
  ('nanu oya',              'Nanu Oya',              6.94, 80.77, 'catalog'),
  ('thanthirimale',         'Thanthirimale',         8.42, 80.22, 'catalog')
ON CONFLICT (canon_key) DO NOTHING;
