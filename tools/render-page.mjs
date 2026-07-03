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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description.replace(/"/g, '&quot;')}">
${robotsTag}${canonical}${og}${headAssets}
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
