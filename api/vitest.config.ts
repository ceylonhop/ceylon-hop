import { defineConfig } from 'vitest/config';

// Generous timeout so DB integration tests tolerate a slow remote Postgres connection;
// in-memory tests finish in milliseconds either way.
export default defineConfig({
  test: { testTimeout: 20000, hookTimeout: 30000 },
});
