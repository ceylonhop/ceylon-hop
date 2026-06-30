import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  DATABASE_URL: z.string().optional(),
  DATABASE_URL_TEST: z.string().optional(),
  ADMIN_API_KEY: z.string().default(''),
  PAYHERE_MERCHANT_ID: z.string().optional(),
  PAYHERE_MERCHANT_SECRET: z.string().optional(),
  PAYHERE_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYHERE_NOTIFY_URL: z.string().optional(),
  APP_BASE_URL: z.string().default('http://localhost:4173'),
  // Browser origins allowed to call the API (comma-separated). The live site + local dev.
  ALLOWED_ORIGINS: z
    .string()
    .default('https://ceylonhop.github.io,https://ceylonhop.com,http://localhost:4173,http://localhost:8787'),
  // Per-IP rate limit on booking writes.
  RATE_LIMIT_MAX: z.coerce.number().default(20),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  // Google Maps (M8). When set, the server uses the real Distance Matrix adapter; otherwise
  // the fake (haversine) adapter. Restrict the key to the Distance Matrix API.
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // Email (M4). When RESEND_API_KEY is set, the server sends real mail via Resend;
  // otherwise the fake adapter (records only). EMAIL_FROM must be a Resend-verified
  // sender (use onboarding@resend.dev for testing before the domain is verified).
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Ceylon Hop <onboarding@resend.dev>'),
  EMAIL_REPLY_TO: z.string().optional(),
  // Ops dashboard auth (Slice 1: per-role keys → signed session cookie).
  OPS_SUPPORT_KEY: z.string().default(''),
  OPS_FOUNDER_KEY: z.string().default(''),
  OPS_SESSION_SECRET: z.string().default('dev-ops-secret-change-me'),
  // Quote engine internal key — passed to quoteRoutes to gate marginEstimateCents.
  INTERNAL_QUOTE_KEY: z.string().default(''),
});

export const config = Env.parse(process.env);
