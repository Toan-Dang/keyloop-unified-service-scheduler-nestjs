import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, env } from '@prisma/config';

// Prisma 7 no longer auto-loads `.env`; Node 24 can do it natively.
const envFile = path.join(__dirname, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
