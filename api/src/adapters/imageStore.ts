import { signV4 } from './sigv4';

// Where uploaded experience photos are kept (spec 2026-10-17 P1/P4): one Cloudflare R2 bucket per
// environment, served publicly from its custom domain (img.ceylonhop.com / img-staging.ceylonhop.com).
// R2 is selected at startup only when EVERY setting is present; otherwise there is no store and uploads
// are off (CLAUDE.md hard rule 4). The token behind R2_ACCESS_KEY_ID is scoped to the one bucket.
export interface ImageStore {
  put(key: string, body: Uint8Array<ArrayBuffer>, meta: { contentType: string; cacheControl: string }): Promise<void>;
}

export class ImageStoreError extends Error {}

// Lower-case path segments only: no leading slash, no "..", nothing that can leave the bucket path.
const KEY = /^[a-z0-9][a-z0-9/._-]{0,200}$/;
const TIMEOUT_MS = 15_000;

export interface R2Settings { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }

export class R2ImageStore implements ImageStore {
  constructor(
    private readonly s: R2Settings,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(key: string, body: Uint8Array<ArrayBuffer>, meta: { contentType: string; cacheControl: string }): Promise<void> {
    if (!KEY.test(key) || key.includes('..')) throw new ImageStoreError(`bad key: ${key}`);
    const url = `https://${this.s.accountId}.r2.cloudflarestorage.com/${this.s.bucket}/${key}`;
    const headers = signV4({
      method: 'PUT', url, body, now: this.now(), region: 'auto',
      accessKeyId: this.s.accessKeyId, secretAccessKey: this.s.secretAccessKey,
      headers: { 'content-type': meta.contentType, 'cache-control': meta.cacheControl },
    });
    const res = await this.fetchFn(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new ImageStoreError(`R2 PUT ${key} -> ${res.status}`);
  }
}

export class FakeImageStore implements ImageStore {
  readonly puts: Array<{ key: string; body: Uint8Array; contentType: string; cacheControl: string }> = [];
  fail = false;
  async put(key: string, body: Uint8Array<ArrayBuffer>, meta: { contentType: string; cacheControl: string }): Promise<void> {
    if (this.fail) throw new ImageStoreError('fake failure');
    this.puts.push({ key, body, ...meta });
  }
}

export function selectImageStore(c: {
  R2_ACCOUNT_ID?: string; R2_ACCESS_KEY_ID?: string; R2_SECRET_ACCESS_KEY?: string; R2_BUCKET?: string; PHOTO_PUBLIC_ORIGIN?: string;
}): { store: ImageStore; publicOrigin: string } | null {
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = c;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !c.PHOTO_PUBLIC_ORIGIN) return null;
  return { store: new R2ImageStore({ accountId, accessKeyId, secretAccessKey, bucket }), publicOrigin: c.PHOTO_PUBLIC_ORIGIN };
}
