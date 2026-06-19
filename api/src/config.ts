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
});

export const config = Env.parse(process.env);
