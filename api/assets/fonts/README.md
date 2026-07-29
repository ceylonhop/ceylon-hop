# Vendored brand fonts

The share-card renderer (`src/routes/shareCardImage.ts`) rasterises SVG to PNG with
`@resvg/resvg-js`, which reads only TTF/OTF — not woff/woff2 — and a Render container
has no system fonts to fall back on. Without these files the card renders blank.

| File | Family | Source |
|---|---|---|
| `Newsreader-ExtraBold.ttf` | Newsreader 800 — display | Google Fonts |
| `HankenGrotesk-Bold.ttf` | Hanken Grotesk 700 — body | Google Fonts |
| `HankenGrotesk-SemiBold.ttf` | Hanken Grotesk 600 — body | Google Fonts |

Both families are licensed under the SIL Open Font License 1.1 (`OFL.txt`), which permits
bundling and redistribution. They are the same two families `site.css` loads for the web,
so the card matches the site rather than approximating it.
