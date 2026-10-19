import { describe, it, expect } from 'vitest';
import { R2ImageStore, FakeImageStore, ImageStoreError, selectImageStore } from './imageStore';
import { sha256Hex } from './sigv4';

const S = { accountId: 'acct123', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'ceylonhop-photos-staging' };
const META = { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' };
const NOW = () => new Date('2026-10-17T05:06:07Z');
const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

function stubFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(null, { status });
  }) as typeof fetch;
  return { f, calls };
}

describe('R2ImageStore', () => {
  it('PUTs to the account endpoint with a signed request and our headers', async () => {
    const { f, calls } = stubFetch();
    await new R2ImageStore(S, f, NOW).put('experiences/abc-900.jpg', body, META);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://acct123.r2.cloudflarestorage.com/ceylonhop-photos-staging/experiences/abc-900.jpg');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(body);
    const h = init.headers as Record<string, string>;
    expect(h['content-type']).toBe('image/jpeg');
    expect(h['cache-control']).toBe(META.cacheControl);
    expect(h['x-amz-content-sha256']).toBe(sha256Hex(body));
    expect(h['x-amz-date']).toBe('20261017T050607Z');
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261017\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it('throws ImageStoreError on a non-2xx answer', async () => {
    const { f } = stubFetch(403);
    await expect(new R2ImageStore(S, f, NOW).put('experiences/abc-900.jpg', body, META)).rejects.toBeInstanceOf(ImageStoreError);
  });

  it('refuses a key that could leave the bucket path, without calling R2', async () => {
    const { f, calls } = stubFetch();
    for (const k of ['../x.jpg', '/abs.jpg', 'experiences/../../x.jpg', 'A.jpg']) {
      await expect(new R2ImageStore(S, f, NOW).put(k, body, META)).rejects.toBeInstanceOf(ImageStoreError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('FakeImageStore', () => {
  it('records puts, and fails on demand', async () => {
    const fake = new FakeImageStore();
    await fake.put('experiences/a-900.jpg', body, META);
    expect(fake.puts).toEqual([{ key: 'experiences/a-900.jpg', body, ...META }]);
    fake.fail = true;
    await expect(fake.put('experiences/b-900.jpg', body, META)).rejects.toBeInstanceOf(ImageStoreError);
  });
});

describe('selectImageStore', () => {
  const ALL = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK', R2_BUCKET: 'b', PHOTO_PUBLIC_ORIGIN: 'https://img.ceylonhop.com' };
  it('is R2 when every setting is present', () => {
    const s = selectImageStore(ALL);
    expect(s?.store).toBeInstanceOf(R2ImageStore);
    expect(s?.publicOrigin).toBe('https://img.ceylonhop.com');
  });
  it('is off (null) when any one is missing', () => {
    for (const k of Object.keys(ALL)) expect(selectImageStore({ ...ALL, [k]: undefined }), k).toBeNull();
  });
});
