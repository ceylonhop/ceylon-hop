import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

// The dev preview harness renders the real sender output (spec 2026-10-06 D21).
describe('/dev/emails/experience-confirmed', () => {
  const app = createApp({ adminApiKey: 'k' });
  it('renders the html and the text alternative', async () => {
    const html = await app.request('/dev/emails/experience-confirmed');
    expect(html.status).toBe(200);
    const body = await html.text();
    expect(body).toContain('Ayurvedic massage');
    expect(body).toContain('Free cancellation up to 24 hours before the experience date.');
    const text = await app.request('/dev/emails/experience-confirmed?format=text');
    expect(await text.text()).toContain('Meeting point: Hotel lobby, Sigiriya Village');
  });
  it('is listed on the index', async () => {
    expect(await (await app.request('/dev/emails')).text()).toContain('experience-confirmed');
  });
});
