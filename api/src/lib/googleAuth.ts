import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name?: string; // Google profile display name — the UI derives avatar initials from it
}

export type JwtVerifier = (
  token: string,
  clientId: string,
) => Promise<{ payload: Record<string, unknown> }>;

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// Cached JWKS — one fetch per process, refreshed by jose on key rotation.
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

// Default verifier: jose checks signature, expiry and audience against Google's keys.
const defaultVerifier: JwtVerifier = async (token, clientId) => {
  const { payload } = await jwtVerify(token, JWKS, {
    audience: clientId,
    // jose validates exp/nbf; issuer checked explicitly below so we can normalise both forms.
  });
  return { payload: payload as Record<string, unknown> };
};

export async function verifyGoogleIdToken(
  token: string,
  opts: { clientId: string; verifier?: JwtVerifier },
): Promise<GoogleIdentity> {
  const verifier = opts.verifier ?? defaultVerifier;
  const { payload } = await verifier(token, opts.clientId);
  const iss = String(payload.iss ?? '');
  if (!GOOGLE_ISSUERS.has(iss)) throw new Error(`bad issuer: ${iss}`);
  const email = payload.email;
  if (typeof email !== 'string' || !email) throw new Error('token has no email');
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : undefined;
  return { email, emailVerified: payload.email_verified === true, ...(name ? { name } : {}) };
}
