import { renderChrome } from './site-chrome.mjs';

const ORIGIN = 'https://ceylonhop.com';

// Full standalone HTML document in the site chrome — used for 404, terms, privacy.
// depth 0 = repo root (relative prefix ''). Pass canonicalPath (e.g. '/terms.html')
// for indexable pages, or robots: 'noindex, follow' for the 404.
export function renderStandalone({ title, description, canonicalPath = null, robots = null, depth = 0, absolute = false, style = '', bodyHtml, active = '' }) {
  // `absolute` = served at any depth (the 404). Use RELATIVE hrefs + a <base> so
  // links resolve from the site root regardless of the missing URL's depth, on both
  // the apex (base "/") and the github.io project path (base "/<repo>/"). Relative is
  // required — <base> does not affect root-absolute URLs.
  const { header, footer, headAssets, bootScript } = renderChrome({ depth: absolute ? 0 : depth, active });
  const canonical = canonicalPath ? `<link rel="canonical" href="${ORIGIN}${canonicalPath}">\n` : '';
  const robotsTag = robots ? `<meta name="robots" content="${robots}">\n` : '';
  const og = canonicalPath
    ? `<meta property="og:type" content="website">
<meta property="og:title" content="${title.replace(/"/g, '&quot;')}">
<meta property="og:description" content="${description.replace(/"/g, '&quot;')}">
<meta property="og:url" content="${ORIGIN}${canonicalPath}">
<meta property="og:site_name" content="Ceylon Hop">
<meta property="og:image" content="${ORIGIN}/og-cover.jpg">\n`
    : '';
  // Inject the <base> before any relative URL is parsed (the stylesheet in headAssets).
  // apex → "/", github.io project path → "/<repo>/".
  const baseFix = absolute
    ? `<script>document.write('<base href="'+(location.hostname.endsWith('github.io')?'/'+location.pathname.split('/')[1]+'/':'/')+'">')</script>\n`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description.replace(/"/g, '&quot;')}">
${robotsTag}${baseFix}${canonical}${og}${headAssets}
${style ? `<style>${style}</style>\n` : ''}</head>
<body>
${header}
<main>
${bodyHtml}
</main>
${footer}
${bootScript}
</body>
</html>
`;
}

export { ORIGIN };
