import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { TrackingCorrelation } from '../domain/trackingContract';

export const REQUEST_ID_HEADER = 'X-Request-Id';

type IdFactory = () => string;

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
  }
}

/**
 * Give every HTTP request one server-owned identifier.
 *
 * Incoming X-Request-Id is deliberately ignored: it is untrusted caller input and must not be
 * able to choose the primary identifier written into future audit rows. If caller correlation is
 * needed later it gets a separate field.
 */
export function requestCorrelation(newId: IdFactory = randomUUID): MiddlewareHandler {
  return async (c, next) => {
    const requestId = newId();
    c.set('requestId', requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    await next();
  };
}

export type JobCorrelation = TrackingCorrelation & { runId: string };

/** One run id per job invocation; passing the result onward never regenerates it. */
export function createJobCorrelation(
  correlation: TrackingCorrelation = {},
  newId: IdFactory = randomUUID,
): JobCorrelation {
  return { ...correlation, runId: correlation.runId ?? newId() };
}

