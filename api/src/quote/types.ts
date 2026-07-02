import type { Vehicle, ExtraCode } from './rateCard';

export interface PrivateLeg { from: string; to: string; distanceKm: number }
export interface SharedLeg { routeId: string; seats: number; seatPriceCents: number; colomboPickup?: boolean }
export interface ChauffeurTravelDay { date: string; from: string; to: string; distanceKm: number }

// customPerKmCents (GL-1d): van14/custom have no fixed owner rate — the operator sets the
// per-km rate at quote time (rate-card values are prefill defaults only). The engine rejects
// an override when the priced vehicle is any other tier.
export type QuoteRequest =
  | { product: 'shared'; legs: SharedLeg[] }
  | { product: 'private'; vehicle: Vehicle; pax: number; bags: number; legs: PrivateLeg[]; extras?: ExtraCode[]; customPerKmCents?: number }
  | { product: 'chauffeur'; vehicle: Vehicle; firstDate: string; lastDate: string; travelDays: ChauffeurTravelDay[]; extras?: ExtraCode[]; customPerKmCents?: number };

export interface LineItem { label: string; amountCents: number; meta?: Record<string, unknown> }

export interface QuoteResult {
  product: 'shared' | 'private' | 'chauffeur';
  currency: 'USD';
  lineItems: LineItem[];
  subtotalCents: number;
  totalCents: number;
  depositCents: number;
  amountDueNowCents: number;
  marginEstimateCents: number | null; // total − cost basis; null for shared (cost not modelled); surfaced to internal/ops callers only
  rateCardVersion: string;
  warnings: string[];
}
