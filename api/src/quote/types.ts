import type { Vehicle, ExtraCode } from './rateCard';

export interface PrivateLeg { from: string; to: string; distanceKm: number }
export interface SharedLeg { routeId: string; seats: number; seatPriceCents: number; colomboPickup?: boolean }
export interface ChauffeurTravelDay { date: string; from: string; to: string; distanceKm: number }

export type QuoteRequest =
  | { product: 'shared'; legs: SharedLeg[] }
  | { product: 'private'; vehicle: Vehicle; pax: number; bags: number; legs: PrivateLeg[]; extras?: ExtraCode[] }
  | { product: 'chauffeur'; vehicle: Vehicle; firstDate: string; lastDate: string; travelDays: ChauffeurTravelDay[]; extras?: ExtraCode[] };

export interface LineItem { label: string; amountCents: number; meta?: Record<string, unknown> }

export interface QuoteResult {
  product: 'shared' | 'private' | 'chauffeur';
  currency: 'USD';
  lineItems: LineItem[];
  subtotalCents: number;
  totalCents: number;
  depositCents: number;
  amountDueNowCents: number;
  marginEstimateCents: number; // total − cost basis; surfaced to internal/ops callers only
  rateCardVersion: string;
  warnings: string[];
}
