import { renderChrome } from './site-chrome.mjs';

const ORIGIN = 'https://ceylonhop.com';

// Full standalone HTML document in the site chrome — used for 404, terms, privacy.
// depth 0 = repo root (relative prefix ''). Pass canonicalPath (e.g. '/terms.html')
// for indexable pages, or robots: 'noindex, follow' for the 404.
export function renderStandalone({ title, description, canonicalPath = null, robots = null, depth = 0, absolute = false, style = '', bodyHtml, active = '' }) {
  const { header, footer, headAssets, bootScript } = renderChrome({ depth, active, absolute });
  const canonical = canonicalPath ? `<link rel="canonical" href="${ORIGIN}${canonicalPath}">\n` : '';
  const robotsTag = robots ? `<meta name="robots" content="${robots}">\n` : '';
  const og = canonicalPath
    ? `<meta property="og:type" content="website">
<meta property="og:title" content="${title.replace(/"/g, '&quot;')}">
<meta property="og:description" content="${description.replace(/"/g, '&quot;')}">
<meta property="og:url" content="${ORIGIN}${canonicalPath}">
<meta property="og:site_name" content="Ceylon Hop">\n`
    : '';
  // Absolute-path pages (404) are served at any depth. On the apex, root-absolute
  // hrefs resolve fine; on the github.io PROJECT path they'd resolve outside
  // /ceylon-hop/, so inject a <base> there. Must run before the stylesheet link.
  const baseFix = absolute
    ? `<script>if(location.hostname.endsWith('github.io'))document.write('<base href="/'+location.pathname.split('/')[1]+'/">')</script>\n`
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
