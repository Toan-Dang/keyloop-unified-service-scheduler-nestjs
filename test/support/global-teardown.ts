import { clearTestEnv } from './test-database';

export default async function globalTeardown(): Promise<void> {
  const containers = globalThis.__USS_CONTAINERS__;
  await containers?.redis?.stop().catch(() => undefined);
  await containers?.postgres?.stop().catch(() => undefined);
  clearTestEnv();
}
