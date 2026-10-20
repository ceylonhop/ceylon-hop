// GA4 Measurement Protocol (spec 2026-10-03). The real adapter is selected at startup only when
// GA4_API_SECRET is set; otherwise nothing is constructed and nothing is sent (CLAUDE.md hard
// rule 4: external services only behind an adapter with a fake). Throws on failure so the
// ledger can record it and the cron sweep can retry. Note: /mp/collect answers 2xx even for a
// malformed hit — correctness is pinned by ga4Hits' own tests, not by this status.

export interface Ga4Item {
  item_id: string; item_name: string;
  item_category: string; item_category2: string; item_category3: string; item_category4: string;
  price: number; quantity: number;
}
export interface Ga4Event { name: string; params: Record<string, string | number | Ga4Item[]> }
export type Ga4Consent = 'GRANTED' | 'DENIED';
export interface Ga4Hit {
  client_id: string;
  timestamp_micros: number;
  consent: { ad_user_data: Ga4Consent; ad_personalization: Ga4Consent };
  events: Ga4Event[];
}

export interface Ga4Adapter {
  send(hit: Ga4Hit): Promise<void>;
}

export class FakeGa4Adapter implements Ga4Adapter {
  readonly sent: Ga4Hit[] = [];
  failNext = 0;
  async send(hit: Ga4Hit): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('ga4_fake_failure');
    }
    this.sent.push(hit);
  }
}

export class MeasurementProtocolAdapter implements Ga4Adapter {
  constructor(private readonly measurementId: string, private readonly apiSecret: string) {}

  async send(hit: Ga4Hit): Promise<void> {
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(this.measurementId)}`
      + `&api_secret=${encodeURIComponent(this.apiSecret)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', body: JSON.stringify(hit), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`ga4_send_failed_${res.status}`);
  }
}
