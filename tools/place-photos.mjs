import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function loadPlacePhotos() {
  return JSON.parse(readFileSync(join(HERE, 'place-photos.json'), 'utf8'));
}

/** Fail loud, like route-content.json: a page with a hole where its photo goes must not generate. */
export function photoFor(photos, id) {
  const p = photos[id];
  if (!p) throw new Error(`place-photos.json missing "${id}"`);
  return p;
}

/** One <img>. `p` is the page's path back to the site root ('../../' on a route page).
 * width/height are the intrinsic size of the largest candidate (the -1800 file) — they only
 * ever set the aspect ratio for the reserved box, so the exact 900w pixel height doesn't matter,
 * and using it (rounded) was 1px off for any odd `photo.h` and shifted layout. */
export function imgTag(photo, { p, sizes, eager = false, cls = '' }) {
  const base = `${p}img/places/${photo.stem}`;
  return `<img${cls ? ` class="${cls}"` : ''} src="${base}-900.jpg" srcset="${base}-900.jpg 900w, ${base}-1800.jpg 1800w" sizes="${sizes}" `
    + `width="${photo.w}" height="${photo.h}" alt="${esc(photo.alt)}" style="object-position:${esc(photo.focal)}" `
    + (eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"') + '>';
}
