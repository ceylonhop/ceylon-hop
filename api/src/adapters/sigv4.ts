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
