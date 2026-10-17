# Experience photo upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ops uploads an experience photo from the Experiences form; it is stored in Cloudflare R2 and shows on ops, the booking page and the pay page straight away, with no PR or promote.

**Architecture:** The browser shrinks the photo to 1800 px and 900 px JPEGs and posts both to `POST /admin/experiences/photos`. The API checks them and PUTs them to an R2 bucket through an `ImageStore` adapter, which signs requests with a small hand-written AWS SigV4 signer. It answers with the photo's address on our image domain (`https://img.ceylonhop.com/experiences/<uuid>`). That address goes into the existing `photos` text array. `photoUrls()` adds `-900.jpg` / `-1800.jpg`, so customer pages see the same `{ small, large }` shape as today.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono 4.13 (`hono/body-limit`) · Zod · Vitest · Playwright (web-tests) · plain JS in `api/src/routes/ops-ui.html`.

**Spec:** `docs/superpowers/specs/2026-10-17-experience-photo-upload-design.md` (P1–P7).

## Global Constraints

- **No new npm dependency.** SigV4 uses `node:crypto`. The body limit uses Hono's built-in `hono/body-limit`.
- **No migration.** `experiences.photos` stays `text[]` (`api/drizzle/0065_experiences.sql:19`).
- **No pricing, generated-file or Pages change.**
- **Config change (Task 4) needs the owner's explicit OK** before it merges (CLAUDE.md maintenance rule 3). The spec PR's approval is that OK only if the owner says so.
- **Image hosts, exactly:** `https://img.ceylonhop.com` (prod) and `https://img-staging.ceylonhop.com` (staging). They are fixed in code, not a setting.
- **Stored upload address:** `<origin>/experiences/<lowercase uuid v4 text>`, with no size suffix.
- **Object keys:** `experiences/<uuid>-1800.jpg` and `experiences/<uuid>-900.jpg`. `Content-Type: image/jpeg`. `Cache-Control: public, max-age=31536000, immutable`.
- **Limits (revised in the build):** each file must start with `FF D8 FF`; `large` ≤ 700 000 bytes; `small` ≤ 250 000 bytes, so the request fits the **app-wide 1 MB body limit** (`app.ts:465-469`, #844 → 413 `payload_too_large`). The route adds no `bodyLimit` of its own, and the browser steps JPEG quality down (0.82 → 0.72 → 0.62 → 0.5) to fit. Task 5/6 code below shows the first draft's numbers; PR C has the built version.
- **Browser resize:** longest edge 1800 and 900, never enlarged, JPEG quality 0.82, white background.
- **ops-ui.html copy:** never put a plain `'` inside a JS string. Use `’` (a stray `'` breaks the whole ops page).
- **Gate before every commit:** `cd api && npm run check` (needs `DATABASE_URL_TEST`) and the web-tests suite (`npm --prefix "$PWD/web-tests" run test:all` from the repo root). Never commit red. Stage files by path, never `git add -A`.
- **Red→green:** every task writes its test, runs it to see it FAIL, then implements. Paste both outputs in the PR.

## File map

| File | Change | Responsibility |
|---|---|---|
| `api/src/adapters/sigv4.ts` | create | AWS Signature V4 headers for one request |
| `api/src/adapters/sigv4.test.ts` | create | pins the signer to AWS's published example |
| `api/src/experiences/experience.ts` | modify | accept upload addresses; `photoUrls()` for them; `PHOTO_UPLOAD_ORIGINS` |
| `api/src/experiences/experience.test.ts` | modify | schema + `photoUrls` cases |
| `api/src/adapters/imageStore.ts` | create | `ImageStore`, `R2ImageStore`, `FakeImageStore`, `selectImageStore` |
| `api/src/adapters/imageStore.test.ts` | create | signed PUT shape, failures, selection |
| `api/src/config.ts` | modify | five settings; `PHOTO_PUBLIC_ORIGIN` validated |
| `api/src/config.test.ts` | modify | origin validation |
| `api/src/routes/opsExperiences.ts` | modify | `POST /photos`; GET says `uploads` |
| `api/src/routes/opsExperiences.test.ts` | modify | endpoint tests |
| `api/src/app.ts` | modify | `photoStore` dep → route |
| `api/src/server.ts` | modify | `selectImageStore(config)` → `photoStore` |
| `api/src/routes/ops-ui.html` | modify | Upload button, resize, post, preview |
| `web-tests/e2e/ops-experiences-page.spec.js` | modify | upload flow, off state, failure |

Suggested PRs (one branch each, merged in order): **A** = Tasks 1–3 (dormant building blocks, no config), **B** = Task 4 (config, owner OK), **C** = Tasks 5–6 (endpoint + UI). Task 7 is the owner's setup and the staging check.

---

### Task 1: SigV4 signer

**Files:**
- Create: `api/src/adapters/sigv4.ts`
- Test: `api/src/adapters/sigv4.test.ts`

**Interfaces:**
- Produces: `signV4(o: SignV4Input): Record<string, string>` returns the headers to send (lower-case names: the caller's headers plus `x-amz-date`, `x-amz-content-sha256` and `authorization`; `host` is signed but **not** returned). Also `sha256Hex(b: string | Uint8Array): string`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/adapters/sigv4.test.ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && npx vitest run src/adapters/sigv4.test.ts`
Expected: FAIL. The suite fails to load because `./sigv4` does not exist.

- [ ] **Step 3: Implement**

```ts
// api/src/adapters/sigv4.ts
import { createHash, createHmac } from 'node:crypto';

// AWS Signature V4 for one S3-style request (spec 2026-10-17 P4). R2 speaks the S3 API with region "auto".
// Hand-written so the API needs no AWS SDK; sigv4.test.ts pins it to AWS's published GET Object example.
// No query strings: the only caller is a plain object PUT.
export const sha256Hex = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');
const hmac = (key: string | Buffer, s: string): Buffer => createHmac('sha256', key).update(s).digest();
// S3 wants RFC 3986 escaping; encodeURIComponent leaves !'()* alone.
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export interface SignV4Input {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  now: Date;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The headers to send: the caller's (lower-cased), x-amz-date, x-amz-content-sha256 and authorization.
 *  `host` is signed but not returned — fetch sets it from the URL. */
export function signV4(o: SignV4Input): Record<string, string> {
  const u = new URL(o.url);
  if (u.search) throw new Error('signV4: query strings are not supported');
  const amzDate = o.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(o.body ?? '');
  const signed: Record<string, string> = { host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  for (const [k, v] of Object.entries(o.headers ?? {})) signed[k.toLowerCase()] = v.trim();
  const names = Object.keys(signed).sort();
  const path = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/');
  const canonical = [o.method, path, '', names.map((n) => `${n}:${signed[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + o.secretAccessKey, day), o.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const out = { ...signed };
  delete out.host;
  return { ...out, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}
```

(This exact code was run against the AWS example on 2026-10-17 and produced `f0e8bdb8…6bdb41`.)

- [ ] **Step 4: Run it to see it pass**

Run: `cd api && npx vitest run src/adapters/sigv4.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/adapters/sigv4.ts api/src/adapters/sigv4.test.ts
git commit -m "feat(photos): AWS SigV4 signer for R2 uploads, pinned to AWS's example"
```

---

### Task 2: Photo values accept an upload address

**Files:**
- Modify: `api/src/experiences/experience.ts:13-15` (`PHOTO_STEM`), `:58-61` (`photoUrls`)
- Test: `api/src/experiences/experience.test.ts`

**Interfaces:**
- Produces: `PHOTO_UPLOAD_ORIGINS: readonly ['https://img.ceylonhop.com', 'https://img-staging.ceylonhop.com']` (used by Task 4's config check). `photoUrls(stem)` keeps its signature and handles both kinds.

- [ ] **Step 1: Write the failing tests** (append inside the file; add `photoUrls` to the import on line 2)

```ts
// api/src/experiences/experience.test.ts — line 2 becomes:
import { ExperienceInputSchema, aboutKm, photoUrls, toPublicExperience, type Experience } from './experience';

// …and append:
const UP = 'https://img.ceylonhop.com/experiences/5f0c2a3e-7b1d-4c2e-9a6f-0d1e2f3a4b5c';

describe('uploaded photos (spec 2026-10-17 P2)', () => {
  it('accepts an upload address on either image host', () => {
    for (const p of [UP, UP.replace('img.', 'img-staging.')]) {
      expect(ExperienceInputSchema.safeParse({ ...valid, photos: [p] }).success).toBe(true);
    }
  });

  it('refuses an address that is not exactly ours', () => {
    for (const p of [
      UP.replace('https:', 'http:'),
      UP.replace('img.ceylonhop.com', 'img.ceylonhop.com.evil.example'),
      UP + '-900.jpg',
      'https://img.ceylonhop.com/experiences/not-a-uuid',
      'https://evil.example/experiences/5f0c2a3e-7b1d-4c2e-9a6f-0d1e2f3a4b5c',
    ]) {
      expect(ExperienceInputSchema.safeParse({ ...valid, photos: [p] }).success, p).toBe(false);
    }
  });

  it('photoUrls adds the size suffix to an upload address and keeps repo paths on the site', () => {
    expect(photoUrls(UP)).toEqual({ small: UP + '-900.jpg', large: UP + '-1800.jpg' });
    expect(photoUrls('guides/sigiriya/ayurveda')).toEqual({
      small: 'https://ceylonhop.com/img/guides/sigiriya/ayurveda-900.jpg',
      large: 'https://ceylonhop.com/img/guides/sigiriya/ayurveda-1800.jpg',
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd api && npx vitest run src/experiences/experience.test.ts`
Expected: FAIL. "accepts an upload address" fails (the regex refuses `https://…`). The photoUrls case fails because the upload address gets `https://ceylonhop.com/img/https://…`.

- [ ] **Step 3: Implement.** Replace lines 13–15 of `experience.ts` with:

```ts
// A path under img/ without the -900/-1800 suffix: experiences/<slug>/<name>, or an existing live photo
// such as guides/sigiriya/ayurveda (spec D8, D20). Or an uploaded photo (spec 2026-10-17 P2): its address
// on one of our two image domains (an R2 bucket each), also without the suffix.
export const PHOTO_UPLOAD_ORIGINS = ['https://img.ceylonhop.com', 'https://img-staging.ceylonhop.com'] as const;
const REPO_PHOTO = /^[a-z0-9-]+(\/[a-z0-9-]+){1,3}$/;
const UPLOADED_PHOTO = /^https:\/\/img(-staging)?\.ceylonhop\.com\/experiences\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHOTO_STEM = z.string().refine((s) => REPO_PHOTO.test(s) || UPLOADED_PHOTO.test(s),
  'use a path under img/, e.g. experiences/slug/name, or upload a photo');
```

and replace `photoUrls` with:

```ts
export function photoUrls(stem: string): { small: string; large: string } {
  const base = UPLOADED_PHOTO.test(stem) ? stem : `${PHOTO_ORIGIN}/img/${stem}`;
  return { small: `${base}-900.jpg`, large: `${base}-1800.jpg` };
}
```

- [ ] **Step 4: Run them to see them pass, plus the existing experience suites**

Run: `cd api && npx vitest run src/experiences src/routes/publicExperiences.test.ts src/routes/opsExperiences.test.ts`
Expected: PASS. The existing "refuses … a bad photo stem" case (`../x`, `treatment`) still passes.

- [ ] **Step 5: Commit**

```bash
git add api/src/experiences/experience.ts api/src/experiences/experience.test.ts
git commit -m "feat(experiences): a photo can be an uploaded address on our image domain"
```

---

### Task 3: ImageStore adapter (R2 + fake)

**Files:**
- Create: `api/src/adapters/imageStore.ts`
- Test: `api/src/adapters/imageStore.test.ts`

**Interfaces:**
- Consumes: `signV4` (Task 1).
- Produces:
  - `interface ImageStore { put(key: string, body: Uint8Array<ArrayBuffer>, meta: { contentType: string; cacheControl: string }): Promise<void> }`
  - `class ImageStoreError extends Error`
  - `class R2ImageStore` with `constructor(s: R2Settings, fetchFn?: typeof fetch, now?: () => Date)`
  - `class FakeImageStore` with `puts` and `fail`
  - `selectImageStore(c): { store: ImageStore; publicOrigin: string } | null`

- [ ] **Step 1: Write the failing test**

```ts
// api/src/adapters/imageStore.test.ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && npx vitest run src/adapters/imageStore.test.ts`
Expected: FAIL. The suite fails to load because `./imageStore` does not exist.

- [ ] **Step 3: Implement**

```ts
// api/src/adapters/imageStore.ts
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
```

- [ ] **Step 4: Run it to see it pass, then the API gate**

Run: `cd api && npx vitest run src/adapters/imageStore.test.ts && npm run check`
Expected: PASS, 7 tests; `npm run check` exits 0. If `tsc` rejects `body` as `BodyInit`, check the installed `@types/node` and fix the type, not the behaviour.

- [ ] **Step 5: Commit, then open PR A (Tasks 1–3)**

```bash
git add api/src/adapters/imageStore.ts api/src/adapters/imageStore.test.ts
git commit -m "feat(photos): ImageStore adapter — R2 (signed PUT) and a fake, off unless fully configured"
```

---

### Task 4: Settings (CONFIG — owner OK required before merge)

**Files:**
- Modify: `api/src/config.ts` (Env schema near the Tripadvisor block, `:147-157`; `buildConfig`, after `:215-220`)
- Test: `api/src/config.test.ts`

**Interfaces:**
- Consumes: `PHOTO_UPLOAD_ORIGINS` (Task 2).
- Produces: `config.R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `PHOTO_PUBLIC_ORIGIN` (all `string | undefined`; the origin is `undefined` unless it is one of the two hosts).

- [ ] **Step 1: Write the failing test** (append to `config.test.ts`; `vi` and `buildConfig` are already imported there, see the `TRIPADVISOR_LOGO_URL` block at `:237`)

```ts
describe('config - PHOTO_PUBLIC_ORIGIN (spec 2026-10-17 P5)', () => {
  it('keeps the two image hosts, a trailing slash trimmed', () => {
    expect(buildConfig({ PHOTO_PUBLIC_ORIGIN: 'https://img.ceylonhop.com' }).PHOTO_PUBLIC_ORIGIN).toBe('https://img.ceylonhop.com');
    expect(buildConfig({ PHOTO_PUBLIC_ORIGIN: 'https://img-staging.ceylonhop.com/' }).PHOTO_PUBLIC_ORIGIN).toBe('https://img-staging.ceylonhop.com');
  });

  it('drops any other value, with a warning (uploads stay off)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const v of ['http://img.ceylonhop.com', 'https://evil.example', 'https://img.ceylonhop.com.evil.example', 'https://ceylonhop.com']) {
      expect(buildConfig({ PHOTO_PUBLIC_ORIGIN: v }).PHOTO_PUBLIC_ORIGIN, v).toBeUndefined();
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is unset by default and when empty, without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildConfig({}).PHOTO_PUBLIC_ORIGIN).toBeUndefined();
    expect(buildConfig({ PHOTO_PUBLIC_ORIGIN: '' }).PHOTO_PUBLIC_ORIGIN).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && npx vitest run src/config.test.ts`
Expected: FAIL. `PHOTO_PUBLIC_ORIGIN` is not in the `Env` schema yet, so Zod strips it and the first case gets `undefined` instead of the origin.

- [ ] **Step 3: Implement.** In the `Env` object, after `TRIPADVISOR_LOGO_URL`:

```ts
  // Experience photo uploads (spec 2026-10-17 P4/P5). Dormant until ALL five are set: an R2 bucket per
  // environment, an API token scoped to it, and the bucket's public custom domain. PHOTO_PUBLIC_ORIGIN must
  // be one of PHOTO_UPLOAD_ORIGINS (validated in buildConfig); any other value leaves uploads off.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  PHOTO_PUBLIC_ORIGIN: z.string().optional(),
```

Add `import { PHOTO_UPLOAD_ORIGINS } from './experiences/experience';` beside the Tripadvisor import (`config.ts:4`). In `buildConfig`, right after the `TRIPADVISOR_LOGO_URL` block:

```ts
  if (cfg.PHOTO_PUBLIC_ORIGIN !== undefined) {
    const origin = cfg.PHOTO_PUBLIC_ORIGIN.trim().replace(/\/+$/, '');
    const ok = (PHOTO_UPLOAD_ORIGINS as readonly string[]).includes(origin);
    if (origin && !ok) console.warn(`[config] PHOTO_PUBLIC_ORIGIN ignored: it must be one of ${PHOTO_UPLOAD_ORIGINS.join(', ')}. Photo uploads stay off.`);
    cfg.PHOTO_PUBLIC_ORIGIN = ok ? origin : undefined;
  }
```

- [ ] **Step 4: Run it to see it pass, then the gate**

Run: `cd api && npx vitest run src/config.test.ts && npm run check`
Expected: PASS; `npm run check` exits 0.

- [ ] **Step 5: Commit, then open PR B. Title it "CONFIG:" and wait for the owner's merge OK.**

```bash
git add api/src/config.ts api/src/config.test.ts
git commit -m "feat(config): R2 photo-upload settings, PHOTO_PUBLIC_ORIGIN limited to our two image hosts"
```

---

### Task 5: Upload endpoint + wiring

**Files:**
- Modify: `api/src/routes/opsExperiences.ts` (deps type `:41-49`; GET `:66-69`; new route after PATCH `/:id`, `:96`)
- Modify: `api/src/app.ts` (AppDeps near `:120`; route mount `:704`)
- Modify: `api/src/server.ts` (beside Tripadvisor `:111`; createApp deps `:204`)
- Test: `api/src/routes/opsExperiences.test.ts`

**Interfaces:**
- Consumes: `ImageStore`, `FakeImageStore`, `selectImageStore` (Task 3); config keys (Task 4); the schema (Task 2).
- Produces: `POST /admin/experiences/photos` (multipart `large`, `small`) → `201 { stem }` | `400 { error: 'bad_request' | 'not_jpeg' | 'too_large', field }` | `413 { error: 'too_large' }` | `502 { error: 'upload_failed' }` | `503 { error: 'uploads_off' }`. `GET /admin/experiences` adds `uploads: boolean`. AppDeps gains `photoStore?: { store: ImageStore; publicOrigin: string } | null`.

- [ ] **Step 1: Write the failing tests** (append to `opsExperiences.test.ts`; add `import { FakeImageStore } from '../adapters/imageStore';`)

```ts
const jpeg = (n: number) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
function photoForm(large: Uint8Array | null = jpeg(2000), small: Uint8Array | null = jpeg(1000)) {
  const f = new FormData();
  if (large) f.set('large', new File([large], 'large.jpg', { type: 'image/jpeg' }));
  if (small) f.set('small', new File([small], 'small.jpg', { type: 'image/jpeg' }));
  return f;
}
function setupPhotos(store: FakeImageStore | null = new FakeImageStore()) {
  const experiences = new InMemoryExperienceRepo();
  const a = realCreateApp({
    auth: AUTH, adminApiKey: 'k', experiences, experienceInterests: new InMemoryExperienceInterestRepo(),
    photoStore: store ? { store, publicOrigin: 'https://img-staging.ceylonhop.com' } : null,
  });
  const upload = (body: FormData, ck: string | null = OPS, extra: Record<string, string> = {}) =>
    a.request('/admin/experiences/photos', { method: 'POST', headers: { ...(ck ? { cookie: ck } : {}), ...extra }, body });
  return { a, store, upload };
}

describe('POST /admin/experiences/photos (spec 2026-10-17)', () => {
  it('401 without a session, 403 for finance, 403 cross-site', async () => {
    const { upload } = setupPhotos();
    expect((await upload(photoForm(), null)).status).toBe(401);
    expect((await upload(photoForm(), FINANCE)).status).toBe(403);
    expect((await upload(photoForm(), OPS, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('503 uploads_off when no store is configured', async () => {
    const { upload } = setupPhotos(null);
    const res = await upload(photoForm());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'uploads_off' });
  });

  it('stores both sizes under one new uuid and answers an address the catalogue accepts', async () => {
    const { a, store, upload } = setupPhotos();
    const large = jpeg(2000), small = jpeg(1000);
    const res = await upload(photoForm(large, small));
    expect(res.status).toBe(201);
    const { stem } = await res.json();
    expect(stem).toMatch(/^https:\/\/img-staging\.ceylonhop\.com\/experiences\/[0-9a-f-]{36}$/);
    const id = stem.split('/').pop();
    expect(store!.puts.map((p) => p.key)).toEqual([`experiences/${id}-1800.jpg`, `experiences/${id}-900.jpg`]);
    expect(store!.puts[0]).toMatchObject({ contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
    expect(Array.from(store!.puts[0]!.body)).toEqual(Array.from(large));
    expect(Array.from(store!.puts[1]!.body)).toEqual(Array.from(small));
    // Round trip: the returned address is a valid photo for a new experience.
    const created = await a.request('/admin/experiences', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: OPS }, body: JSON.stringify({ ...BODY, photos: [stem] }),
    });
    expect(created.status).toBe(201);
  });

  it('400 for a missing file, a non-JPEG, or an oversize small', async () => {
    const { store, upload } = setupPhotos();
    expect(await (await upload(photoForm(jpeg(2000), null))).json()).toEqual({ error: 'bad_request', field: 'small' });
    expect(await (await upload(photoForm(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), jpeg(10)))).json()).toEqual({ error: 'not_jpeg', field: 'large' });
    expect(await (await upload(photoForm(jpeg(2000), jpeg(600_001)))).json()).toEqual({ error: 'too_large', field: 'small' });
    expect(store!.puts).toHaveLength(0);
  });

  it('413 for a body over 4 MB', async () => {
    const { store, upload } = setupPhotos();
    const res = await upload(photoForm(jpeg(4_300_000), jpeg(1000)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(store!.puts).toHaveLength(0);
  });

  it('502 upload_failed when the store fails', async () => {
    const store = new FakeImageStore();
    store.fail = true;
    const { upload } = setupPhotos(store);
    const res = await upload(photoForm());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upload_failed' });
  });

  it('the catalogue GET says whether uploads are on', async () => {
    const on = setupPhotos();
    expect((await (await on.a.request('/admin/experiences', { headers: { cookie: OPS } })).json()).uploads).toBe(true);
    const off = setupPhotos(null);
    expect((await (await off.a.request('/admin/experiences', { headers: { cookie: OPS } })).json()).uploads).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd api && npx vitest run src/routes/opsExperiences.test.ts`
Expected: FAIL. `photoStore` is not an AppDeps key (type error under vitest, or 404s on `/photos`), and `uploads` is undefined.

- [ ] **Step 3: Implement the route.** In `opsExperiences.ts` add the imports:

```ts
import { randomUUID } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import type { ImageStore } from '../adapters/imageStore';
```

Add to the deps type (after `email: EmailAdapter;`):

```ts
  /** Photo uploads (spec 2026-10-17). Absent/null = uploads off: the form hides the Upload buttons. */
  photos?: { store: ImageStore; publicOrigin: string } | null;
```

Change the GET body to:

```ts
    return c.json({ experiences: list.map(serialize), stats, uploads: !!deps.photos });
```

After the `r.patch('/:id', …)` handler, add:

```ts
  // Photo upload (spec 2026-10-17 P3). The browser has already shrunk the photo to two JPEGs; this checks
  // they ARE JPEGs of a sane size and stores both under one new uuid. Saving the experience is a separate
  // POST/PATCH, so a failed upload changes nothing.
  const PHOTO_MAX = { large: 2_500_000, small: 600_000 } as const;
  const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  r.post('/photos', csrf, requireCap('experiences:manage'),
    bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }),
    async (c) => {
      if (!deps.photos) return c.json({ error: 'uploads_off' }, 503);
      const form = await c.req.parseBody().catch(() => null);
      const files = {} as Record<'large' | 'small', Uint8Array<ArrayBuffer>>;
      for (const k of ['large', 'small'] as const) {
        const f = form?.[k];
        if (!(f instanceof File)) return c.json({ error: 'bad_request', field: k }, 400);
        const b = new Uint8Array(await f.arrayBuffer());
        if (!isJpeg(b)) return c.json({ error: 'not_jpeg', field: k }, 400);
        if (b.length > PHOTO_MAX[k]) return c.json({ error: 'too_large', field: k }, 400);
        files[k] = b;
      }
      const id = randomUUID();
      const meta = { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' };
      try {
        await deps.photos.store.put(`experiences/${id}-1800.jpg`, files.large, meta);
        await deps.photos.store.put(`experiences/${id}-900.jpg`, files.small, meta);
      } catch (err) {
        console.error('[experiences] photo upload failed:', err);
        return c.json({ error: 'upload_failed' }, 502);
      }
      return c.json({ stem: `${deps.photos.publicOrigin}/experiences/${id}` }, 201);
    });
```

- [ ] **Step 4: Wire it.** `app.ts`, in AppDeps beside `tripadvisorLogoUrl`:

```ts
  /** Experience photo uploads (spec 2026-10-17). Absent/null = uploads off. */
  photoStore?: { store: ImageStore; publicOrigin: string } | null;
```

with `import type { ImageStore } from './adapters/imageStore';` next to the Tripadvisor type import (`app.ts:16`). In the mount at `:704`, add `photos: deps.photoStore` to the `opsExperiencesRoutes({ … })` argument.

`server.ts`, under the Tripadvisor line (`:111`):

```ts
// Experience photo uploads (spec 2026-10-17) - R2 only when all five settings are present; otherwise off.
const photoStore = selectImageStore(config);
```

with `import { selectImageStore } from './adapters/imageStore';` beside `selectTripadvisor`, and in the createApp deps after `experienceInterests: …` (`:206`):

```ts
  photoStore,
```

- [ ] **Step 5: Run the tests to see them pass, then the gate**

Run: `cd api && npx vitest run src/routes/opsExperiences.test.ts && npm run check`
Expected: PASS, including the 7 new tests; `npm run check` exits 0.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/opsExperiences.ts api/src/routes/opsExperiences.test.ts api/src/app.ts api/src/server.ts
git commit -m "feat(experiences): POST /admin/experiences/photos stores two JPEG sizes in R2"
```

---

### Task 6: Ops form — Upload button

**Files:**
- Modify: `api/src/routes/ops-ui.html` (constants `:9140-9142`; `expPhotoUrl` `:9192`; `loadExperiences` `:9202`; photo loop + label in `renderExpForm` `:9563-9583`; `expPhotoPreview` `:9639-9646`; click dispatcher `:9791-9800`)
- Test: `web-tests/e2e/ops-experiences-page.spec.js`

**Interfaces:**
- Consumes: `POST /admin/experiences/photos` and `GET /admin/experiences` `uploads` (Task 5).

- [ ] **Step 1: Write the failing e2e tests** (append to the spec; `boot`, `ready`, `json`, `GIF`, `OPS`, `OPS_FILE`, `STATS` already exist there)

```js
// Photo upload (spec 2026-10-17 P6).
const UPLOADED = 'https://img-staging.ceylonhop.com/experiences/5f0c2a3e-7b1d-4c2e-9a6f-0d1e2f3a4b5c';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const withUploads = { list: (r, db) => r.fulfill(json({ experiences: db, stats: STATS, uploads: true })) };

async function stubUpload(page, reply) {
  const posts = [];
  // Registered after boot's '**/admin/experiences/*' route: Playwright prefers the last match.
  await page.route('**/admin/experiences/photos', (r) => { posts.push(r.request().postDataBuffer()); return reply(r); });
  await page.route('https://img-staging.ceylonhop.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));
  return posts;
}

async function pickPhoto(page, slot) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-testid="exp-photo-upload-' + slot + '"]').click();
  await (await chooser).setFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
}

test('upload: a picked photo is shrunk to two JPEGs, fills the slot and previews at once', async ({ page }) => {
  await boot(page, OPS, withUploads);
  const posts = await stubUpload(page, (r) => r.fulfill(json({ stem: UPLOADED }, 201)));
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await pickPhoto(page, 0);
  await expect(page.locator('#exp-photo-0')).toHaveValue(UPLOADED);
  await expect(page.locator('#exp-photo-0-prev img')).toHaveAttribute('src', UPLOADED + '-900.jpg');
  await expect(page.locator('#exp-photo-0-prev [data-testid="exp-photo-note"]')).toHaveCount(0);
  expect(posts).toHaveLength(1);
  const body = posts[0].toString('latin1');
  expect(body).toContain('name="large"');
  expect(body).toContain('name="small"');
  expect(body.split('\xff\xd8\xff').length - 1).toBe(2); // two JPEGs, even from a PNG
});

test('upload: no Upload buttons when the server has uploads off', async ({ page }) => {
  await boot(page, OPS);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await expect(page.locator('#exp-photo-0')).toBeVisible();
  await expect(page.locator('[data-testid^="exp-photo-upload-"]')).toHaveCount(0);
});

test('upload: a failed upload says so and leaves the slot as it was', async ({ page }) => {
  await boot(page, OPS, withUploads);
  await stubUpload(page, (r) => r.fulfill(json({ error: 'upload_failed' }, 502)));
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await pickPhoto(page, 2);
  await expect(page.locator('[data-err="photos"]')).toHaveText('Upload failed — try again.');
  await expect(page.locator('#exp-photo-2')).toHaveValue('');
  await expect(page.locator('[data-testid="exp-photo-upload-2"]')).toHaveText('Upload');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `(cd web-tests && npx playwright test e2e/ops-experiences-page.spec.js -g "upload:")`
Expected: FAIL. The first and third time out waiting for `[data-testid="exp-photo-upload-…"]`. The second may already pass, which is fine: it guards the off state.

- [ ] **Step 3: Implement in `ops-ui.html`.**

(a) Under `var EXP_PHOTO_ORIGIN = …` (`:9141`):

```js
// An uploaded photo's address (spec 2026-10-17 P2) — mirrors UPLOADED_PHOTO in experience.ts.
var EXP_PHOTO_UPLOADED = /^https:\/\/img(-staging)?\.ceylonhop\.com\/experiences\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
```

(b) Replace `expPhotoUrl` (`:9192`):

```js
function expPhotoUrl(stem) { return (EXP_PHOTO_UPLOADED.test(stem) ? stem : EXP_PHOTO_ORIGIN + '/img/' + stem) + '-900.jpg'; } // photoUrls(stem).small
```

(c) In `loadExperiences`, the `expData = …` line becomes:

```js
      expData = { experiences: d.experiences, stats: Array.isArray(d.stats) ? d.stats : [], uploads: d.uploads === true };
```

(d) In `renderExpForm`, replace the photo loop (`:9563-9567`):

```js
  var up = !!(expData && expData.uploads);
  var photos = '';
  for (var i = 0; i < 6; i++) {
    photos += '<div style="display:flex;gap:6px;align-items:center;margin-top:' + (i ? 6 : 0) + 'px">'
      + '<div class="ch-input-wrap" style="flex:1"><input id="exp-photo-' + i + '" class="ch-input" data-photo="' + i + '" autocomplete="off" placeholder="experiences/' + (i ? 'slug/photo-' + (i + 1) : 'slug/photo-1') + '" value="' + esc(d.photos[i] || '') + '"></div>'
      + (up ? '<button type="button" class="ch-btn ch-btn-outline ch-btn-sm" data-action="expPhotoPick" data-slot="' + i + '" data-testid="exp-photo-upload-' + i + '">Upload</button>' : '')
      + '</div>'
      + '<div class="ch-exp-prev" id="exp-photo-' + i + '-prev"></div>';
  }
  if (up) photos += '<input type="file" id="exp-photo-file" accept="image/jpeg,image/png,image/webp" hidden>';
```

and the photos field line (`:9583`):

```js
    + expField('photos', up ? 'Photos (up to 6 — upload one, or type a path under img/ without -900/-1800)' : 'Photos (up to 6 — a path under img/, without -900/-1800)', photos, 'ch-exp-wide')
```

(e) Replace the body of `expPhotoPreview` after `if (!inp || !out) return;`:

```js
  var stem = inp.value.trim();
  // An uploaded photo is live the moment the upload succeeds, so it never gets the "Not live yet" note.
  out.innerHTML = EXP_PHOTO_UPLOADED.test(stem)
    ? '<img class="ch-exp-img" alt="" src="' + esc(expPhotoUrl(stem)) + '">'
    : EXP_PHOTO_STEM.test(stem)
      ? '<img class="ch-exp-img" alt="" src="' + esc(expPhotoUrl(stem)) + '"><span class="ch-exp-note" data-testid="exp-photo-note" hidden>' + EXP_NOT_LIVE + '</span>'
      : '';
```

(f) In the click dispatcher, after the `expSave` line:

```js
  else if (action === 'expPhotoPick') expPhotoPick(Number(el.getAttribute('data-slot')));
```

(g) New functions, placed right after `expPhotoPreview`:

```js
// Photo upload (spec 2026-10-17 P3/P6): shrink in the browser to the guides' two sizes (drawing on a canvas
// also drops the camera data, GPS included), post both, put the returned address in the slot. Nothing is
// saved until ops presses Save.
var _expPhotoSlot = -1;
var EXP_UPLOAD_ERR = {
  too_large: 'This photo is too big even after shrinking — try a smaller one.',
  not_jpeg: 'Couldn’t read this photo — save it as JPEG and try again.',
  uploads_off: 'Uploads are off on this server.',
};
function expPhotoPick(slot) {
  var f = document.getElementById('exp-photo-file');
  if (!f) return;
  _expPhotoSlot = slot;
  f.value = '';
  f.click();
}
document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || t.id !== 'exp-photo-file' || !t.files || !t.files[0] || _expPhotoSlot < 0) return;
  expPhotoUpload(_expPhotoSlot, t.files[0]);
});
async function expShrink(file, edge) {
  var bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  var s = Math.min(1, edge / Math.max(bmp.width, bmp.height)); // never enlarge
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  var ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // a transparent PNG would otherwise turn black as a JPEG
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise(function (res, rej) {
    c.toBlob(function (b) { b ? res(b) : rej(new Error('encode failed')); }, 'image/jpeg', 0.82);
  });
}
async function expPhotoUpload(slot, file) {
  var btn = expEl && expEl.querySelector('[data-action="expPhotoPick"][data-slot="' + slot + '"]');
  var err = expEl && expEl.querySelector('[data-err="photos"]');
  if (err) err.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  try {
    var large, small;
    try { large = await expShrink(file, 1800); small = await expShrink(file, 900); }
    catch (x) { if (err) err.textContent = EXP_UPLOAD_ERR.not_jpeg; return; }
    var fd = new FormData();
    fd.append('large', large, 'large.jpg');
    fd.append('small', small, 'small.jpg');
    var res = await api('/admin/experiences/photos', { method: 'POST', body: fd });
    var j = await jsonOrNull(res);
    if (!res.ok || !j || typeof j.stem !== 'string') {
      if (err) err.textContent = (j && EXP_UPLOAD_ERR[j.error]) || 'Upload failed — try again.';
      return;
    }
    var inp = document.getElementById('exp-photo-' + slot);
    if (inp) { inp.value = j.stem; expPhotoPreview(slot); }
  } catch (x) {
    if (err) err.textContent = 'Upload failed — try again.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }
  }
}
```

- [ ] **Step 4: Run the e2e tests to see them pass, then both gates**

Run: `(cd web-tests && npx playwright test e2e/ops-experiences-page.spec.js)` then `cd api && npm run check` then, from the repo root, `npm --prefix "$PWD/web-tests" run test:all`
Expected: the whole spec passes (the existing photo-path tests too); both gates exit 0. Read the runner's own summary line and exit code, not a piped tail.

- [ ] **Step 5: Look at it.** Open the ops page in the browser pane (`exp-api` / `exp-site` launch entries, or the e2e file route) and check the Upload button lines up beside each box at desktop and 375 px width. Take a screenshot for the PR.

- [ ] **Step 6: Commit, then open PR C (Tasks 5–6)**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-experiences-page.spec.js
git commit -m "feat(ops): upload experience photos from the form — shrunk in the browser, live at once"
```

---

### Task 7: Owner setup + staging check (after PRs A–C are on `main`)

No code. The owner does the console steps; the agent checks with them.

- [ ] **Step 1: Owner — Cloudflare (staging).** R2 → enable (note whether it asked for a card). Create bucket `ceylonhop-photos-staging` (location hint Asia-Pacific). Bucket → Settings → Custom domain → `img-staging.ceylonhop.com`. Confirm no Cloudflare Access application covers that hostname. R2 → Manage API tokens → **Object Read & Write**, scoped to that one bucket → copy the Access Key ID and Secret. Write down which menu names differed from these (the spec marks them unverified).
- [ ] **Step 2: Owner — Render staging** → Environment: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=ceylonhop-photos-staging`, `PHOTO_PUBLIC_ORIGIN=https://img-staging.ceylonhop.com` → save (redeploys).
- [ ] **Step 3: Check staging.** In ops.staging → Experiences → edit a placeholder: the Upload buttons show. Upload one phone photo and one desktop photo; save. Then:
  - `curl -sI https://img-staging.ceylonhop.com/experiences/<uuid>-900.jpg` → `200`, `content-type: image/jpeg`, `cache-control: public, max-age=31536000, immutable`.
  - `curl -s 'https://<staging api>/experiences/near?at=Sigiriya@7.9571,80.7601'` → that experience's `photos[0].small` is the `img-staging` address.
  - Download the 1800 file and run `exiftool` (or `mdls`) on it: no GPS fields.
  - An iPhone HEIC photo either uploads or shows "Couldn’t read this photo…" (record which in the spec's P3).
- [ ] **Step 4: Prod.** Promote PR `main → production` (pin the SHA; CI green; owner merges). Then the owner repeats Steps 1–2 for `ceylonhop-photos` / `img.ceylonhop.com` / the prod Render service. Check `GET /health` shows the promoted SHA, then do one upload on ops and repeat the `curl -sI` check.
