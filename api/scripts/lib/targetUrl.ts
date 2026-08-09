// Shared guard for the operational scripts that read/write a database by an explicit env var
// (never process.env.DATABASE_URL — see the callers for why).
//
// Exists because the `postgres` driver throws `TypeError: Invalid URL` for anything it can't
// parse as a URL, and that error's `input` field holds the value verbatim — Node prints the
// whole thing. An operator once pasted a bare password into BACKFILL_DATABASE_URL and it came
// back out in cleartext, in scrollback, in a screenshot they'd already shared. This module makes
// that specific failure mode impossible: validate the shape BEFORE the value ever reaches the
// driver, and redact it out of anything that gets thrown afterwards too.

const CONNECTION_STRING_PATTERN = /^postgres(ql)?:\/\//i;

/**
 * Reads `envVarName`, requires it to be set, and requires it to look like a Postgres connection
 * string. Never includes the value itself in a thrown message — only its absence or its shape is
 * reported, so a bare password (or anything else pasted by mistake) can never be echoed back.
 *
 * `verb` fills in the specific ask, e.g. "write to" or "read", so callers keep their own wording.
 */
export function requireConnectionUrl(envVarName: string, verb: string): string {
  const url = process.env[envVarName];
  if (!url) {
    throw new Error(
      `Set ${envVarName} to the database you mean to ${verb}. ` +
        'DATABASE_URL is not used here on purpose — api/.env points at production.',
    );
  }
  if (!CONNECTION_STRING_PATTERN.test(url)) {
    throw new Error(
      `${envVarName} does not look like a Postgres connection string (expected it to start ` +
        'with "postgres://" or "postgresql://"). If you pasted a password — or anything else ' +
        'that is not a connection string — by mistake, it is now sitting in your shell history ' +
        'in the clear. Rotate it.',
    );
  }
  return url;
}

/**
 * Strips a connection string (and, defensively, just its password) out of arbitrary text. Used
 * to sanitise whatever a downstream driver error says before it's re-thrown or logged — a
 * well-formed URL with a wrong password can still produce a driver error, and nothing guarantees
 * that error's message never quotes the connection string back.
 */
/**
 * The operator-facing text for a thrown driver error, redacted.
 *
 * Drizzle wraps a failed query in a `DrizzleQueryError` whose own message is only the SQL it
 * tried — the actual Postgres reason ("relation ... does not exist", "password authentication
 * failed") lives on `.cause`. Reporting `.message` alone leaves the operator staring at their own
 * query with no idea why it failed, which is exactly what happened the first time these scripts
 * were run against staging. Walk the chain.
 */
export function describeDbError(err: unknown, url: string): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (current.message) parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (!parts.length) parts.push(String(err));
  return redactConnectionString(parts.join(' — caused by: '), url);
}

export function redactConnectionString(text: string, url: string): string {
  let result = text.split(url).join('[connection string redacted]');
  try {
    const { password } = new URL(url);
    if (password) {
      result = result.split(password).join('[redacted]');
      result = result.split(encodeURIComponent(password)).join('[redacted]');
    }
  } catch {
    // url wasn't parseable as a URL — nothing more specific to redact beyond the literal match
    // above.
  }
  return result;
}
