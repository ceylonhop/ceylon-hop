import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  REQUEST_ID_HEADER,
  createJobCorrelation,
  requestCorrelation,
} from './correlation';

const REQUEST_1 = '11111111-1111-4111-8111-111111111111';
const REQUEST_2 = '22222222-2222-4222-8222-222222222222';
const RUN_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('requestCorrelation', () => {
  it('sets one server-owned request id in context and the response header', async () => {
    const app = new Hono();
    const nextId = vi.fn(() => REQUEST_1);
    app.use('*', requestCorrelation(nextId));
    app.get('/probe', (c) => c.json({ requestId: c.get('requestId') }));

    const response = await app.request('/probe', {
      headers: { 'x-request-id': 'caller-controlled' },
    });

    expect(await response.json()).toEqual({ requestId: REQUEST_1 });
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_1);
    expect(nextId).toHaveBeenCalledTimes(1);
  });

  it('creates a new request id for the next request', async () => {
    const ids = [REQUEST_1, REQUEST_2];
    const app = new Hono();
    app.use('*', requestCorrelation(() => ids.shift()!));
    app.get('/probe', (c) => c.text(c.get('requestId')));

    expect(await (await app.request('/probe')).text()).toBe(REQUEST_1);
    expect(await (await app.request('/probe')).text()).toBe(REQUEST_2);
  });
});

describe('createJobCorrelation', () => {
  it('adds one run id while preserving the request id', () => {
    const nextId = vi.fn(() => RUN_1);
    const correlation = createJobCorrelation({ requestId: REQUEST_1 }, nextId);

    expect(correlation).toEqual({ requestId: REQUEST_1, runId: RUN_1 });
    expect(nextId).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing run id within the same run', () => {
    const nextId = vi.fn(() => RUN_2);
    const correlation = createJobCorrelation(
      { requestId: REQUEST_1, runId: RUN_1 },
      nextId,
    );

    expect(correlation).toEqual({ requestId: REQUEST_1, runId: RUN_1 });
    expect(nextId).not.toHaveBeenCalled();
  });

  it('gives separate job invocations different run ids', () => {
    const ids = [RUN_1, RUN_2];
    const nextId = () => ids.shift()!;

    expect(createJobCorrelation({ requestId: REQUEST_1 }, nextId).runId).toBe(RUN_1);
    expect(createJobCorrelation({ requestId: REQUEST_1 }, nextId).runId).toBe(RUN_2);
  });
});

