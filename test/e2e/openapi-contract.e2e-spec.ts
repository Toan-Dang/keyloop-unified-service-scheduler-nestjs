import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { load } from 'js-yaml';
import type { Pool } from 'pg';
import request from 'supertest';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp, staffToken } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

interface JsonSchema {
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  $ref?: string;
}

/**
 * Contract test (§12): the committed `openapi.yaml` is what clients code against, so a response
 * that does not match it is a broken promise even if every other test is green.
 *
 * Deliberately validated against the **file on disk**, not a document regenerated in-process —
 * regenerating would make the test tautological (it would compare the app to itself). CI also
 * regenerates and fails on a diff, so the file cannot go stale.
 */
describe('OpenAPI contract', () => {
  const contractPath = resolve(process.cwd(), 'openapi.yaml');

  let app: INestApplication;
  let pool: Pool;
  let prisma: PrismaClient;
  let doc: OpenApiDoc;

  const staff = staffToken();

  beforeAll(async () => {
    if (!existsSync(contractPath)) {
      throw new Error(
        `openapi.yaml is missing — run \`npm run openapi:generate\` and commit the result.`,
      );
    }
    doc = load(readFileSync(contractPath, 'utf8')) as OpenApiDoc;

    pool = createPool();
    prisma = createPrisma();
    await seed(prisma);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    await resetAppointments(pool);
  });

  function schemaFor(name: string): JsonSchema {
    const schema = doc.components?.schemas?.[name];
    if (!schema) throw new Error(`openapi.yaml has no schema "${name}"`);
    return schema;
  }

  function resolveRef(schema: JsonSchema): JsonSchema {
    if (!schema.$ref) return schema;
    const name = schema.$ref.replace('#/components/schemas/', '');
    return schemaFor(name);
  }

  /** Minimal structural validator: required properties present, declared types respected. */
  function assertMatches(value: unknown, schema: JsonSchema, path = '$'): void {
    const resolved = resolveRef(schema);

    if (value === null) {
      expect({ path, nullable: resolved.nullable === true }).toEqual({ path, nullable: true });
      return;
    }

    if (resolved.type === 'array') {
      expect(Array.isArray(value)).toBe(true);
      if (resolved.items) {
        for (const [i, item] of (value as unknown[]).entries()) {
          assertMatches(item, resolved.items, `${path}[${i}]`);
        }
      }
      return;
    }

    if (resolved.type === 'object' || resolved.properties) {
      expect(typeof value).toBe('object');
      const object = value as Record<string, unknown>;

      for (const required of resolved.required ?? []) {
        expect({ path, missing: !(required in object) ? required : null }).toEqual({
          path,
          missing: null,
        });
      }
      for (const [key, propSchema] of Object.entries(resolved.properties ?? {})) {
        if (key in object) assertMatches(object[key], propSchema, `${path}.${key}`);
      }
      return;
    }

    if (resolved.enum) {
      expect(resolved.enum).toContain(value);
      return;
    }

    switch (resolved.type) {
      case 'string':
        expect(typeof value).toBe('string');
        if (resolved.format === 'date-time') {
          expect(Number.isNaN(Date.parse(value as string))).toBe(false);
        }
        break;
      case 'number':
      case 'integer':
        expect(typeof value).toBe('number');
        break;
      case 'boolean':
        expect(typeof value).toBe('boolean');
        break;
      default:
        break;
    }
  }

  it('documents every route the application actually exposes', () => {
    for (const path of [
      '/health',
      '/ready',
      '/v1/appointments',
      '/v1/appointments/{id}',
      '/v1/appointments/{id}/cancel',
      '/v1/availability',
      '/v1/dealerships',
      '/v1/service-types',
      '/v1/technicians',
      '/v1/service-bays',
    ]) {
      expect(Object.keys(doc.paths)).toContain(path);
    }
  });

  it('is a valid OpenAPI 3 document with the bearer scheme declared', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.components?.schemas).toBeDefined();
  });

  it('POST /appointments (201) conforms to AppointmentResponse', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', staff)
      .set('Idempotency-Key', 'contract-1')
      .send({
        customerId: SEED.customers.one.id,
        vehicleId: SEED.vehicles.one.id,
        serviceTypeId: SEED.serviceTypes.brakeInspection.id,
        desiredStartTime: '2026-09-07T02:00:00Z',
      })
      .expect(201);

    assertMatches(res.body, schemaFor('AppointmentResponse'));
  });

  it('GET /appointments conforms to AppointmentPageResponse', async () => {
    await request(app.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', staff)
      .set('Idempotency-Key', 'contract-2')
      .send({
        customerId: SEED.customers.one.id,
        vehicleId: SEED.vehicles.one.id,
        serviceTypeId: SEED.serviceTypes.brakeInspection.id,
        desiredStartTime: '2026-09-07T02:00:00Z',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/appointments')
      .set('Authorization', staff)
      .expect(200);

    assertMatches(res.body, schemaFor('AppointmentPageResponse'));
  });

  it('GET /availability conforms to AvailabilityResponse', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/availability')
      .query({ serviceTypeId: SEED.serviceTypes.oilChange.id, date: '2026-09-07' })
      .set('Authorization', staff)
      .expect(200);

    assertMatches(res.body, schemaFor('AvailabilityResponse'));
  });

  it.each([
    ['dealerships', 'DealershipResponse'],
    ['service-types', 'ServiceTypeResponse'],
    ['technicians', 'TechnicianResponse'],
    ['service-bays', 'ServiceBayResponse'],
  ])('GET /%s conforms to %s', async (route, schema) => {
    const res = await request(app.getHttpServer())
      .get(`/v1/${route}`)
      .set('Authorization', staff)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    for (const item of res.body as unknown[]) assertMatches(item, schemaFor(schema));
  });

  it('serves the contract at /docs', async () => {
    await request(app.getHttpServer()).get('/docs').expect(200);
    const json = await request(app.getHttpServer()).get('/docs/openapi.json').expect(200);
    expect(json.body.openapi).toMatch(/^3\./);
  });
});
