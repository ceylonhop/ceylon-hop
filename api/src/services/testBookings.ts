// Test bookings (2026-09-24). Production cannot tell the owner's and team's own test bookings
// from customers': a 60-day abandoned-payment audit had to be cleaned by hand (CH-T74DT was
// keyboard mash, CH-CQDMQ the owner re-testing a customer's pay link under the owner's own
// email, six August rows owner tests), and every count in the ops queue, its "need attention"
// badge and the daily digest included them. The ONE predicate that decides "this is one of
// ours" lives here; callers get the team set from config.TEAM_EMAILS (comma-separated, parsed
// once at boot by parseTeamEmails). An empty set makes the whole feature inert.

/** Parse a comma-separated TEAM_EMAILS string into a lower-cased, trimmed set. */
export function parseTeamEmails(raw: string | undefined): Set<string> {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when `email` (trimmed, case-insensitive) is one of the team's addresses. */
export function isTeamEmail(email: string | null | undefined, team: ReadonlySet<string>): boolean {
  if (!email || team.size === 0) return false;
  return team.has(email.trim().toLowerCase());
}
