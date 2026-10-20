import { describe, it, expect } from 'vitest';
import { signV4, sha256Hex } from './sigv4';

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('signV4', () => {
  it("matches AWS's published GET Object example", () => {
    const h = signV4({
      method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' },
      now: new Date('2013-05-24T00:00:00Z'), region: 'us-east-1', ...AWS,
    });
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(h['x-amz-date']).toBe('20130524T000000Z');
    expect(h.range).toBe('bytes=0-9');
    expect(h.host).toBeUndefined(); // fetch sets Host from the URL
  });

  it('hashes the body it is given (empty body = the SHA-256 of nothing)', () => {
    const now = new Date('2026-10-17T00:00:00Z');
    const body = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    expect(signV4({ method: 'PUT', url: 'https://a.example/b/k.jpg', body, now, region: 'auto', ...AWS })['x-amz-content-sha256'])
      .toBe(sha256Hex(body));
    expect(signV4({ method: 'GET', url: 'https://a.example/b/k.jpg', now, region: 'auto', ...AWS })['x-amz-content-sha256'])
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('refuses a query string (the only caller is a plain object PUT)', () => {
    expect(() => signV4({ method: 'GET', url: 'https://a.example/b?x=1', now: new Date(), region: 'auto', ...AWS })).toThrow(/query/);
  });
});
