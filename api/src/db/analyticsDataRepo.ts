import type { BusinessAnalyticsData } from '../services/analytics/business';

export interface AnalyticsDataRange {
  from: Date;
  to: Date;
  previousFrom: Date;
  now: Date;
  upcomingThrough: string;
  teamEmails: ReadonlySet<string>;
  limit: number;
}

export interface AnalyticsDataRepo {
  load(range: AnalyticsDataRange): Promise<BusinessAnalyticsData>;
}

export class EmptyAnalyticsDataRepo implements AnalyticsDataRepo {
  async load(): Promise<BusinessAnalyticsData> {
    return {
      bookings: [], payments: [], refunds: [], checkoutEvents: [], rideLists: [],
      excluded: { teamBookings: 0, teamQuoteContacts: 0, seedRideLists: 0, teamRideMembers: 0 },
      truncated: false,
    };
  }
}
