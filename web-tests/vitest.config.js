import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['unit/**/*.test.js'],
    globals: false,
  },
});
