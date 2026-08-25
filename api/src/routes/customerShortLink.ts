import { Hono, type Context } from 'hono';
import type { CustomerShortLinkRepo } from '../db/customerShortLinkRepo';
import { customerShortCodeDigest, isCustomerShortCode } from '../lib/customerShortLink';
import { signQuotePayToken, signQuoteViewToken } from '../lib/bookingToken';

export interface CustomerShortLinkDeps {
  shortLinks: CustomerShortLinkRepo;
  linkSecret: string;
  payBaseUrl: string;
  quoteBaseUrl: string;
  reportError: (err: unknown) => void;
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

function host(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
}

export function customerShortLinkRoutes(deps: CustomerShortLinkDeps) {
  const r = new Hono();
  const payBase = base(deps.payBaseUrl);
  const quoteBase = base(deps.quoteBaseUrl);
  const payHost = host(payBase);
  const quoteHost = host(quoteBase);

  function unavailable(c: Context) {
    noStore(c);
    const requestHost = new URL(c.req.url).hostname.toLowerCase();
    // With one shared customer hostname there is no target kind to select a generic page from.
    if (quoteHost === payHost && requestHost === quoteHost) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (requestHost === quoteHost) return c.redirect(`${quoteBase}/q?t=invalid`, 302);
    if (requestHost === payHost) return c.redirect(`${payBase}/p?t=invalid`, 302);
    return c.json({ error: 'not_found' }, 404);
  }

  r.get('/:code', async (c) => {
    const code = c.req.param('code');
    if (!isCustomerShortCode(code)) return unavailable(c);

    try {
      const target = await deps.shortLinks.getByDigest(customerShortCodeDigest(code));
      if (!target) return unavailable(c);

      noStore(c);
      if (target.kind === 'quote_view') {
        const token = signQuoteViewToken(target.quoteId, deps.linkSecret);
        return c.redirect(`${quoteBase}/q?t=${encodeURIComponent(token)}`, 302);
      }
      const token = signQuotePayToken(
        target.quoteId,
        target.revision,
        deps.linkSecret,
        target.seq,
      );
      return c.redirect(`${payBase}/p?t=${encodeURIComponent(token)}`, 302);
    } catch (err) {
      // Never include the bearer code in logs or let the global path-aware error reporter see it.
      deps.reportError(err);
      noStore(c);
      return c.json({ error: 'temporarily_unavailable' }, 503);
    }
  });

  return r;
}
