import { describe, it, expect } from 'vitest';
import { verifyGoogleIdToken, type JwtVerifier } from './googleAuth';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';

// A fake verifier that returns a chosen payload, standing in for jose+JWKS.
const verifierReturning = (payload: Record<string, unknown>): JwtVerifier =>
  async () => ({ payload });

describe('verifyGoogleIdToken', () => {
  it('returns the verified email + verification flag on a good token', async () => {
    const v = verifierReturning({
      iss: 'https://accounts.google.com', aud: CLIENT_ID,
      email: 'Person@x.com', email_verified: true,
    });
    const id = await verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v });
    expect(id).toEqual({ email: 'Person@x.com', emailVerified: true });
  });

  it('rejects a token whose issuer is not Google', async () => {
    const v = verifierReturning({ iss: 'https://evil.com', aud: CLIENT_ID, email: 'a@x.com', email_verified: true });
    await expect(verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v })).rejects.toThrow(/issuer/i);
  });

  it('propagates a verifier failure (bad signature / aud / expiry)', async () => {
    const v: JwtVerifier = async () => { throw new Error('signature verification failed'); };
    await expect(verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v })).rejects.toThrow();
  });

  it('surfaces the Google profile name so the UI can show the user\'s initials', async () => {
    const v = verifierReturning({
      iss: 'https://accounts.google.com', aud: CLIENT_ID,
      email: 'sandra@x.com', email_verified: true, name: 'Sandra Wolker',
    });
    const id = await verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v });
    expect(id.name).toBe('Sandra Wolker');
  });

  it('leaves name undefined when the token has no usable name claim', async () => {
    const noName = verifierReturning({ iss: 'accounts.google.com', aud: CLIENT_ID, email: 'a@x.com', email_verified: true });
    expect((await verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: noName })).name).toBeUndefined();
    const blank = verifierReturning({ iss: 'accounts.google.com', aud: CLIENT_ID, email: 'a@x.com', email_verified: true, name: '   ' });
    expect((await verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: blank })).name).toBeUndefined();
  });

  it('surfaces email_verified === false as emailVerified:false (caller decides)', async () => {
    const v = verifierReturning({ iss: 'accounts.google.com', aud: CLIENT_ID, email: 'a@x.com', email_verified: false });
    const id = await verifyGoogleIdToken('tok', { clientId: CLIENT_ID, verifier: v });
    expect(id.emailVerified).toBe(false);
  });
});
