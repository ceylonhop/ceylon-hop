import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Prototype (owner, 2026-11-01): Claude drafts ops quotes from a pasted WhatsApp message by calling
// the existing /admin/quote/* API. Auth = the operator's own ch_ops browser cookie, so every quote
// is created as them and the API's role rules apply unchanged. STAGING ONLY until real API tokens
// exist — a founder cookie is full founder power, so loadConfig refuses production hosts.
//
// Deliberately draft-only: no approve, discount, pay-link, book or send tools. Customer text is
// untrusted, and a person still reviews and sends every quote through the normal maker-checker.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface Config { baseUrl: string; cookie: string }

const DEFAULT_BASE = 'https://ops.staging.ceylonhop.com';

export function loadConfig(env: Record<string, string | undefined>): Config {
  const raw = (env.CEYLON_HOP_OPS_COOKIE ?? '').trim();
  if (!raw) throw new Error('Set CEYLON_HOP_OPS_COOKIE to your ch_ops cookie from the staging ops page (see mcp/README.md).');
  const cookie = raw.replace(/^ch_ops=/, '');
  const baseUrl = (env.CEYLON_HOP_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const host = new URL(baseUrl).hostname;
  const allowed = host === 'localhost' || host === '127.0.0.1' || host.includes('staging');
  if (!allowed) throw new Error(`Refusing ${host}: this prototype only talks to staging (or localhost).`);
  return { baseUrl, cookie };
}

// Mirrors ToolRequestSchema in api/src/routes/internalQuote.ts (the API re-validates; this copy is
// what tells Claude the shape). No `discount` key — zod strips it, so one can never be forwarded.
const legSchema = z.object({
  from: z.string().describe('Pickup place, as returned by search_places'),
  to: z.string().describe('Drop-off place, as returned by search_places'),
  date: z.string().optional().describe('YYYY-MM-DD. Omit if the customer has not said.'),
  category: z.enum(['transfer', 'airport', 'train_support', 'stay_day']).optional()
    .describe('airport for airport pickups/drops; stay_day for a day the driver stays with them; else transfer'),
  stops: z.array(z.string()).min(2).max(8).optional()
    .describe('Only for multi-stop rides: ordered stops, first = from, last = to'),
  addSightseeingFee: z.boolean().optional(),
  addWaitingFee: z.boolean().optional(),
  addSafariWait: z.boolean().optional(),
});

const tripShape = {
  id: z.string().optional().describe('Existing quote id to update in place (save only). Omit to create a new quote.'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  contact: z.string().optional().describe('Customer WhatsApp number or email'),
  notes: z.string().optional().describe('Customer-facing notes'),
  internalNotes: z.string().optional().describe('Ops-only notes, e.g. the original WhatsApp message'),
  service: z.enum(['private', 'chauffeur']).optional()
    .describe('private = point-to-point transfers; chauffeur = driver stays with them for a multi-day trip'),
  requestedService: z.enum(['private', 'chauffeur', 'both']).optional()
    .describe('What the customer actually asked for. Leave unset if unclear.'),
  vehicle: z.enum(['car', 'van_6', 'van_9', 'van_14', 'custom'])
    .describe('car fits up to 3 pax with luggage; van_6 / van_9 / van_14 for bigger groups'),
  passengerCount: z.number().int().min(1),
  luggageCount: z.number().int().min(0),
  legs: z.array(legSchema).min(1),
};

const QUOTE_STATUSES = ['draft', 'pending_review', 'changes_requested', 'ready', 'sent', 'won', 'lost', 'expired'] as const;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export function buildServer(cfg: Config, fetchImpl: FetchLike = fetch): McpServer {
  const server = new McpServer({ name: 'ceylon-hop-quotes', version: '0.1.0' });

  async function call(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
    const res = await fetchImpl(`${cfg.baseUrl}/admin/quote${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: `ch_ops=${cfg.cookie}`, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const textBody = await res.text();
    let data: unknown = textBody;
    try { data = JSON.parse(textBody); } catch { /* non-JSON: keep the text */ }
    return { ok: res.ok, status: res.status, data };
  }

  function reply(r: { ok: boolean; status: number; data: unknown }, extra?: string): ToolResult {
    if (r.status === 401 || r.status === 403) {
      return { isError: true, content: [{ type: 'text', text:
        `Ops API refused the request (${r.status}). The ch_ops cookie has probably expired or the account lacks access — `
        + 'sign in to the staging ops page again and update CEYLON_HOP_OPS_COOKIE.' }] };
    }
    const out = JSON.stringify(r.data, null, 2);
    if (!r.ok) return { isError: true, content: [{ type: 'text', text: `Ops API error ${r.status}: ${out}` }] };
    return { content: [{ type: 'text', text: extra ? `${extra}\n\n${out}` : out }] };
  }

  server.registerTool('search_places', {
    description: 'Look up a Sri Lankan place name in the ops place list. ALWAYS call this for every pickup, '
      + 'drop-off and stop before pricing, and use the returned label exactly.',
    inputSchema: { query: z.string().min(2) },
  }, async ({ query }) => reply(await call(`/places?q=${encodeURIComponent(query)}`)));

  server.registerTool('estimate_quote', {
    description: 'Price a trip WITHOUT saving anything. Use it to check a price or compare options '
      + '(car vs van, private vs chauffeur — the response includes a `services` comparison). '
      + 'Amounts are integer cents. If anything essential (dates, pax, places) is missing, ask the user instead of guessing.',
    inputSchema: tripShape,
  }, async ({ id: _id, ...trip }) => reply(await call('/estimate', trip)));

  server.registerTool('save_quote_draft', {
    description: 'Save the trip as a DRAFT quote in the ops queue (assigned to the signed-in operator). '
      + 'Call estimate_quote first and confirm with the user. A person still reviews, approves and sends it in ops.',
    inputSchema: tripShape,
  }, async (trip) => {
    const r = await call('/save', trip);
    const id = (r.data as { id?: string } | null)?.id;
    return reply(r, r.ok && id ? `Draft saved. Open it in ops: ${cfg.baseUrl}/ops?quote=${encodeURIComponent(id)}` : undefined);
  });

  server.registerTool('get_quote', {
    description: 'Fetch one saved quote (by its id, not the Q- reference) with its current price.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => reply(await call(`/${encodeURIComponent(id)}`)));

  server.registerTool('list_quotes', {
    description: 'List ops quotes in the queue, optionally filtered by status.',
    inputSchema: { status: z.enum(QUOTE_STATUSES).optional() },
  }, async ({ status }) => reply(await call(`/list${status ? `?status=${status}` : ''}`)));

  return server;
}
