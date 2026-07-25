// Display names for ops staff, captured from the Google profile at sign-in.
//
// WHY a table and not OPS_USERS: the roster (email→role) is env config the owner edits by
// hand; names are facts Google already knows about each person, so making the owner retype
// them — and keep them current — is work the system can do itself. Role stays in env, name
// lives here; the two are joined at read time in /admin/ops/users.
//
// Consequence to remember: a name only exists once that person has authenticated at least
// once since this shipped. Every read path must tolerate a miss (see displayNameFor).
export interface OpsUserProfileRepo {
  // Idempotent: called on every sign-in, so it also picks up a changed Google name.
  upsert(email: string, name: string): Promise<void>;
  namesByEmail(): Promise<Map<string, string>>;
}

// Emails are lowercased to match parseOpsUsers/roleForEmail, so 'Roshen@…' and 'roshen@…'
// are one person here too. A blank name is not stored — it would render as an empty label
// and beat the local-part fallback that exists precisely for the no-name case.
export function normaliseProfile(email: string, name: string): { email: string; name: string } | null {
  const key = (email ?? '').trim().toLowerCase();
  const value = (name ?? '').trim();
  return key && value ? { email: key, name: value } : null;
}

export class InMemoryOpsUserProfileRepo implements OpsUserProfileRepo {
  private byEmail = new Map<string, string>();

  async upsert(email: string, name: string): Promise<void> {
    const row = normaliseProfile(email, name);
    if (!row) return;
    this.byEmail.set(row.email, row.name);
  }

  async namesByEmail(): Promise<Map<string, string>> {
    return new Map(this.byEmail);
  }
}
