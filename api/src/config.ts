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
});

export const config = Env.parse(process.env);
