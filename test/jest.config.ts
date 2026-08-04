import type { Config } from 'jest';
import { resolve } from 'node:path';

// Jest 30 loads a .ts config as ESM, where `__dirname` does not exist. Every npm script here
// runs from the package root, so cwd is the repo root.
const rootDir = process.cwd();

const tsTransform: Config['transform'] = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: resolve(rootDir, 'tsconfig.json') }],
};

const common = {
  rootDir,
  transform: tsTransform,
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/src/$1',
    '^@test/(.*)$': '<rootDir>/test/$1',
  },
  testEnvironment: 'node' as const,
  clearMocks: true,
};

/**
 * Four suites, deliberately separated so the fast ones can run on every save and the slow,
 * container-backed ones run on demand (§12):
 *
 * `maxWorkers` is a GLOBAL Jest option, not a per-project one — setting it here would be
 * silently ignored. Every suite below except `unit` shares ONE database, so the npm scripts pass
 * `--runInBand`. Without it, two spec files land in separate workers and truncate each other's
 * rows mid-test, which shows up as a booking that "succeeded" against an empty table.
 *
 *   unit         — pure logic (hours arithmetic, half-open boundaries, DST enumeration). No I/O.
 *   integration  — repository + the exclusion constraints against a REAL PostgreSQL.
 *   concurrency  — the signature test: N parallel bookings for one slot ⇒ exactly one 201.
 *   e2e          — the HTTP surface via Supertest against a booted Nest app.
 *
 * Everything but `unit` needs real PostgreSQL, because an in-memory or mocked database cannot
 * run a btree_gist EXCLUDE constraint — and the constraint is the thing under test.
 */
const config: Config = {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts', '<rootDir>/src/**/*.spec.ts'],
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/jest.setup.ts'],
      testTimeout: 120_000,
    },
    {
      ...common,
      displayName: 'concurrency',
      testMatch: ['<rootDir>/test/concurrency/**/*.spec.ts'],
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/jest.setup.ts'],
      testTimeout: 300_000,
    },
    {
      ...common,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/jest.setup.ts'],
      testTimeout: 180_000,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts'],
  coverageDirectory: '<rootDir>/coverage',
};

export default config;
