// Founder API for the ops Rates page (spec docs/superpowers/specs/2026-09-26-ops-rates-page-design.md
// §7, §8.4). Reads need margin:view (the set carries our costs); every write needs rates:manage +
// the same CSRF rule as the other admin writes. Saves are append-only revisions — see
// db/rateRevisionRepo.ts — and take effect on the very next price (quote/liveCard.ts).
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { StaleRatesError, type RateRevision, type RateRevisionRepo } from '../db/rateRevisionRepo';
import { RATE_CARD } from '../quote/rateCard';
import { applyRates, previewSamples, rateInputsSchema, ratesFromCard } from '../quote/rateRevision';
import { currentRateCard } from '../quote/liveCard';

const VERSION = z.string().trim().min(1).max(40);
const SaveSchema = z.object({
  baseVersion: VERSION.nullable(),
  rates: rateInputsSchema,
  revertedToVersion: VERSION.nullable().optional(),
}).strict();
const PreviewSchema = z.object({ rates: rateInputsSchema }).strict();

function serialize(r: RateRevision) {
  return {
    id: r.id,
    seq: r.seq,
    version: r.version,
    rates: r.rates,
    revertedToVersion: r.revertedToVersion,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}

export function opsRatesRoutes(deps: {
  revisions: RateRevisionRepo;
  auth: OpsAuthConfig;
  allowedOrigins?: string[];
  now?: () => Date;
}) {
  const r = new Hono();
  const now = deps.now ?? (() => new Date());

  // Same CSRF rule as /admin/quote and /admin/promo-codes: the ch_ops cookie is ambient browser state.
  const csrf: MiddlewareHandler = async (c, next) => {
    const site = c.req.header('sec-fetch-site');
    if (site) {
      if (site !== 'same-origin' && site !== 'none') return c.json({ error: 'bad_origin' }, 403);
      return next();
    }
    const origin = c.req.header('origin');
    if (origin && !(deps.allowedOrigins ?? []).includes(origin)) return c.json({ error: 'bad_origin' }, 403);
    return next();
  };

  r.use('*', opsIdentity(deps.auth));

  r.get('/', requireCap('margin:view'), async (c) => {
    const history = await deps.revisions.list();
    const latest = history[0] ?? null;
    const defaults = { version: RATE_CARD.version, rates: ratesFromCard(RATE_CARD) };
    return c.json({
      live: latest
        ? { version: latest.version, source: 'revision', rates: latest.rates, createdBy: latest.createdBy, createdAt: latest.createdAt.toISOString() }
        : { ...defaults, source: 'defaults', createdBy: null, createdAt: null },
      defaults,
      history: history.map(serialize),
      // Shown, never edited: no booking charges a deposit (engine.ts:171, owner decision 2026-09-26).
      readOnly: { depositPct: RATE_CARD.deposit.pct, depositCapCents: RATE_CARD.deposit.capCents },
    });
  });

  r.post('/', csrf, requireCap('rates:manage'), async (c) => {
    const parsed = SaveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const { baseVersion, rates, revertedToVersion } = parsed.data;
    // A revert is a label on a normal save — make sure it names something that exists.
    if (revertedToVersion && revertedToVersion !== RATE_CARD.version
      && !(await deps.revisions.list()).some((h) => h.version === revertedToVersion)) {
      return c.json({ error: 'bad_request', issues: [{ path: ['revertedToVersion'], message: 'unknown version' }] }, 400);
    }
    try {
      const revision = await deps.revisions.create(
        { rates, baseVersion, revertedToVersion: revertedToVersion ?? null, createdBy: c.get('identity').email },
        now(),
      );
      return c.json({ revision: serialize(revision) }, 201);
    } catch (e) {
      if (e instanceof StaleRatesError) {
        return c.json({ error: 'stale_rates', current: e.current ? serialize(e.current) : null }, 409);
      }
      throw e;
    }
  });

  r.post('/preview', csrf, requireCap('rates:manage'), async (c) => {
    const parsed = PreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
    const current = await currentRateCard(deps.revisions);
    const proposed = applyRates(RATE_CARD, parsed.data.rates, 'preview');
    return c.json({ samples: previewSamples(current, proposed) });
  });

  return r;
}
