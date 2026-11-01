import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, loadConfig, type FetchLike } from './server';

const STAGING = 'https://ops.staging.ceylonhop.com';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

// A fake ops API: records every request and answers with the given status/body.
function fakeApi(status = 200, body: unknown = { ok: true }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

async function connect(fetch: FetchLike) {
  const server = buildServer({ baseUrl: STAGING, cookie: 'abc.def' }, fetch);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

const TRIP = {
  firstName: 'Anna',
  contact: '+44 7700 900123',
  vehicle: 'car',
  passengerCount: 2,
  luggageCount: 2,
  legs: [{ from: 'Bandaranaike International Airport', to: 'Ella', date: '2026-12-03' }],
};

describe('loadConfig', () => {
  it('defaults to staging and needs the session cookie', () => {
    expect(() => loadConfig({})).toThrow(/CEYLON_HOP_OPS_COOKIE/);
    expect(loadConfig({ CEYLON_HOP_OPS_COOKIE: 'abc' })).toEqual({ baseUrl: STAGING, cookie: 'abc' });
  });

  it('accepts a pasted "ch_ops=…" cookie as well as the bare value', () => {
    expect(loadConfig({ CEYLON_HOP_OPS_COOKIE: 'ch_ops=abc.def' }).cookie).toBe('abc.def');
  });

  it('refuses production hosts — this prototype is staging-only', () => {
    for (const url of ['https://ceylonhop.com', 'https://ops.ceylonhop.com', 'https://ceylon-hop-api.onrender.com']) {
      expect(() => loadConfig({ CEYLON_HOP_OPS_COOKIE: 'x', CEYLON_HOP_API_BASE: url })).toThrow(/staging/);
    }
    expect(loadConfig({ CEYLON_HOP_OPS_COOKIE: 'x', CEYLON_HOP_API_BASE: 'http://localhost:8787/' }).baseUrl)
      .toBe('http://localhost:8787');
  });
});

describe('quote MCP tools', () => {
  it('exposes only the drafting tools — nothing that approves, discounts, books or sends', async () => {
    const client = await connect(fakeApi().fetch);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['estimate_quote', 'get_quote', 'list_quotes', 'save_quote_draft', 'search_places']);
  });

  it('search_places calls /admin/quote/places with the session cookie', async () => {
    const api = fakeApi(200, { places: ['Ella'] });
    const client = await connect(api.fetch);
    const r = await client.callTool({ name: 'search_places', arguments: { query: 'Ella town' } });
    expect(api.calls[0].url).toBe(`${STAGING}/admin/quote/places?q=Ella%20town`);
    expect(api.calls[0].headers.cookie).toBe('ch_ops=abc.def');
    expect(text(r)).toContain('Ella');
  });

  it('estimate_quote POSTs the trip to /admin/quote/estimate', async () => {
    const api = fakeApi(200, { totalCents: 9500 });
    const client = await connect(api.fetch);
    const r = await client.callTool({ name: 'estimate_quote', arguments: TRIP });
    expect(api.calls[0]).toMatchObject({ url: `${STAGING}/admin/quote/estimate`, method: 'POST', body: TRIP });
    expect(text(r)).toContain('9500');
  });

  it('save_quote_draft saves via /admin/quote/save and returns a link to open it in ops', async () => {
    const api = fakeApi(201, { id: 'q-123', reference: 'Q-ABCDE', status: 'draft' });
    const client = await connect(api.fetch);
    const r = await client.callTool({ name: 'save_quote_draft', arguments: TRIP });
    expect(api.calls[0]).toMatchObject({ url: `${STAGING}/admin/quote/save`, method: 'POST', body: TRIP });
    expect(text(r)).toContain(`${STAGING}/ops?quote=q-123`);
  });

  it('never forwards a discount, even if one is passed in', async () => {
    const api = fakeApi(201, { id: 'q-1' });
    const client = await connect(api.fetch);
    await client.callTool({ name: 'save_quote_draft', arguments: { ...TRIP, discount: { method: 'percentage', basisPoints: 5000 } } });
    expect(api.calls[0].body).not.toHaveProperty('discount');
  });

  it('get_quote and list_quotes read the queue', async () => {
    const api = fakeApi(200, { quotes: [] });
    const client = await connect(api.fetch);
    await client.callTool({ name: 'get_quote', arguments: { id: 'a/b' } });
    await client.callTool({ name: 'list_quotes', arguments: { status: 'draft' } });
    expect(api.calls.map((c) => c.url)).toEqual([
      `${STAGING}/admin/quote/a%2Fb`,
      `${STAGING}/admin/quote/list?status=draft`,
    ]);
  });

  it('turns an expired cookie (401) into an error that says how to fix it', async () => {
    const client = await connect(fakeApi(401, { error: 'unauthorized' }).fetch);
    const r = await client.callTool({ name: 'list_quotes', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/cookie/i);
  });

  it('passes API validation errors back so Claude can correct the trip', async () => {
    const client = await connect(fakeApi(400, { error: 'date must be YYYY-MM-DD' }).fetch);
    const r = await client.callTool({ name: 'estimate_quote', arguments: TRIP });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('date must be YYYY-MM-DD');
  });
});
