import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const HANDOFF_DIR = resolve(ROOT, 'test/.tmp');
const HANDOFF_FILE = resolve(HANDOFF_DIR, 'test-env.json');

export interface TestEnv {
  databaseUrl: string;
  redisUrl: string;
  /** True when this run provisioned its own containers (and must tear them down). */
  managed: boolean;
}

/**
 * Integration, concurrency and e2e suites all need a **real PostgreSQL** — a btree_gist EXCLUDE
 * constraint cannot be emulated, and the constraint is precisely what is under test (§12).
 *
 * Default: Testcontainers spins up `postgres:18-alpine` per run.
 *
 * Escape hatch: set `TEST_DATABASE_URL` (and optionally `TEST_REDIS_URL`) to point the suites at
 * an already-running PostgreSQL — e.g. the `docker compose` stack — for environments where the
 * Docker socket is not reachable from the test process (Docker Desktop with WSL integration
 * disabled is the common case). The proof is unchanged: it is still real PostgreSQL running the
 * real constraint. CI uses the Testcontainers path.
 */
export function readTestEnv(): TestEnv {
  if (process.env.DATABASE_URL && process.env.REDIS_URL && process.env.TEST_ENV_READY === '1') {
    return {
      databaseUrl: process.env.DATABASE_URL,
      redisUrl: process.env.REDIS_URL,
      managed: false,
    };
  }
  if (!existsSync(HANDOFF_FILE)) {
    throw new Error(
      'Test environment not initialised — did the Jest globalSetup run? ' +
        'Run suites via `npm run test:integration` / `test:concurrency` / `test:e2e`.',
    );
  }
  return JSON.parse(readFileSync(HANDOFF_FILE, 'utf8')) as TestEnv;
}

export function writeTestEnv(env: TestEnv): void {
  mkdirSync(HANDOFF_DIR, { recursive: true });
  writeFileSync(HANDOFF_FILE, JSON.stringify(env), 'utf8');
  process.env.DATABASE_URL = env.databaseUrl;
  process.env.REDIS_URL = env.redisUrl;
  process.env.TEST_ENV_READY = '1';
}

export function clearTestEnv(): void {
  rmSync(HANDOFF_FILE, { force: true });
}

/**
 * Applies the hand-written SQL migration with `migrate deploy` — never `migrate dev`, which
 * would read the raw-SQL objects (EXCLUDE constraints, generated column, partial indexes) as
 * drift and offer to drop them.
 */
export function applyMigrations(databaseUrl: string): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}
