// Guards `npm run migrate:test` (scripts/migrate.ts) against migrating production. The script
// loads api/.env, whose DATABASE_URL is the production database — so it must refuse outright
// when DATABASE_URL_TEST is unset, never fall back to DATABASE_URL.
//
// The script runs on import, so it is exercised as a child process. That child can't reach any
// real database even if the guard regressed: DATABASE_URL_TEST is removed, dotenv is pointed at
// a file that doesn't exist (so api/.env is never read), and DATABASE_URL is a dead address.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_DIR = fileURLToPath(new URL('../..', import.meta.url));
const DEAD_URL = 'postgres://nobody@127.0.0.1:9/never';

describe('scripts/migrate.ts (npm run migrate:test)', () => {
  it('refuses to run without DATABASE_URL_TEST instead of falling back to DATABASE_URL', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: DEAD_URL,
      DOTENV_CONFIG_PATH: fileURLToPath(new URL('./no-such.env', import.meta.url)),
    };
    delete env.DATABASE_URL_TEST;

    const result = spawnSync('node_modules/.bin/tsx', ['scripts/migrate.ts'], {
      cwd: API_DIR,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Set DATABASE_URL_TEST to the database you mean to migrate/);
    expect(result.stderr).toMatch(/DATABASE_URL is not used here on purpose/);
    expect(result.stdout).not.toContain('migrations applied');
  });
});
