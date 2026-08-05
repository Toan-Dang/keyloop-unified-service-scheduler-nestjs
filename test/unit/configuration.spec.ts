import { loadConfiguration } from '../../src/config/configuration';

/**
 * `AUTH_ENABLED=false` used to silently leave every `@CurrentPrincipal()` handler with no
 * principal at all (a request-time 403 on every route, not a working bypass). The fix makes the
 * dev-bypass dealership a required, validated setting instead — these pin that it fails at boot,
 * loudly, rather than per-request.
 */
describe('loadConfiguration — auth dev-bypass', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults to auth enabled, with no dev dealership required', () => {
    delete process.env.AUTH_ENABLED;
    delete process.env.AUTH_DEV_DEALERSHIP_ID;

    expect(loadConfiguration().auth).toEqual({ enabled: true, devDealershipId: '' });
  });

  it('throws at load time when AUTH_ENABLED=false and no AUTH_DEV_DEALERSHIP_ID is set', () => {
    process.env.AUTH_ENABLED = 'false';
    delete process.env.AUTH_DEV_DEALERSHIP_ID;

    expect(() => loadConfiguration()).toThrow(/AUTH_DEV_DEALERSHIP_ID/);
  });

  it('carries the configured dev dealership through when AUTH_ENABLED=false', () => {
    process.env.AUTH_ENABLED = 'false';
    process.env.AUTH_DEV_DEALERSHIP_ID = '0190aaaa-0000-7000-8000-000000000099';

    expect(loadConfiguration().auth).toEqual({
      enabled: false,
      devDealershipId: '0190aaaa-0000-7000-8000-000000000099',
    });
  });
});
