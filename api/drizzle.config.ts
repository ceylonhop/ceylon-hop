import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const raw = process.env.DATABASE_URL ?? '';
const url = raw.includes('sslmode=') ? raw : raw + (raw.includes('?') ? '&' : '?') + 'sslmode=require';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
