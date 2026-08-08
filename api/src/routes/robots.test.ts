import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

// pay./quote./ops. are all this one app. None of them may be indexed: they serve customer names,
// prices and an admin dashboard. The pages already carry <meta robots>, but a meta tag cannot
// protect a JSON response — and nothing was telling a crawler to stay away before fetching.
const app = () => createApp({ adminApiKey: 'k', bookingLinkSecret: 's' });

describe('nothing on the API host may be indexed', () => {
  it('sends X-Robots-Tag on an HTML page', async () => {
    const res = await app().request('/p');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  // The gap a meta tag cannot close: /quotes/pay/view answers application/json.
  it('sends X-Robots-Tag on a JSON response too', async () => {
    const res = await app().request('/quotes/pay/view?t=nonsense');
    expect(res.headers.get('content-type')).toContain('json');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('sends it even on a 404', async () => {
    const res = await app().request('/no-such-path-anywhere');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('asks not to be archived or cached by search engines', async () => {
    const tag = (await app().request('/p')).headers.get('x-robots-tag') ?? '';
    expect(tag).toContain('nofollow');
    expect(tag).toContain('noarchive');
  });
});

describe('robots.txt', () => {
  it('is served, rather than 404ing as it does today', async () => {
    const res = await app().request('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('shuts out every crawler by default', async () => {
    const body = await (await app().request('/robots.txt')).text();
    expect(body).toMatch(/User-agent: \*\s*\nDisallow: \//);
  });

  // The named unfurl card is deliberate — it makes forwarding a quote visibly personal
  // (spec 2026-08-06). A flat Disallow would turn every WhatsApp link into a bare URL.
  it('still lets the link-preview agents through', async () => {
    const body = await (await app().request('/robots.txt')).text();
    for (const agent of ['facebookexternalhit', 'WhatsApp', 'Twitterbot', 'Slackbot-LinkExpanding']) {
      expect(body, agent).toContain(`User-agent: ${agent}`);
    }
    // Each preview agent is allowed, and the wildcard group comes LAST so it cannot shadow them.
    expect(body.indexOf('User-agent: *')).toBeGreaterThan(body.indexOf('facebookexternalhit'));
  });

  it('names the AI crawlers explicitly, since they ignore the wildcard in practice', async () => {
    const body = await (await app().request('/robots.txt')).text();
    for (const bot of ['GPTBot', 'CCBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot']) {
      expect(body, bot).toContain(bot);
    }
  });
});
