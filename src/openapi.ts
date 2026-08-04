import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const API_PREFIX = 'v1';

/**
 * The OpenAPI 3 contract stands in for the client layer (§7): it is what a reviewer, cURL, or a
 * future UI codes against. Generated from the DTOs so it cannot drift from the implementation,
 * and committed as `openapi.yaml` via `npm run openapi:generate`.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Unified Service Scheduler')
    .setDescription(
      [
        'Resource-constrained dealership service booking.',
        '',
        'A booking consumes **one qualified technician and one service bay** for its whole',
        'window. No double-booking is guaranteed physically by two PostgreSQL `btree_gist`',
        'EXCLUDE constraints — not by application logic (ADR-001).',
        '',
        '**Tenancy.** The dealership is resolved from the access token and is never a request',
        'field. A resource belonging to another dealership returns `404`, not `403` — there is no',
        'existence leak across tenants.',
        '',
        '**Auth (stubbed).** `Authorization: Bearer <base64url JSON>` carrying',
        '`{"dealershipId":"…","role":"STAFF"|"CUSTOMER","customerId":"…"}`. This is the seam a',
        'real IdP plugs into.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description: 'Stubbed principal token — base64url of the claims JSON.',
      },
      'bearer',
    )
    .addGlobalParameters({
      name: 'x-correlation-id',
      in: 'header',
      required: false,
      description: 'Optional client-supplied correlation id; echoed on the response.',
      schema: { type: 'string' },
    })
    .addTag('appointments', 'Book, read, list and cancel appointments')
    .addTag('availability', 'Advisory availability preview')
    .addTag('reference', 'Reference data: dealerships, service types, technicians, bays')
    .addTag('operations', 'Health, readiness and metrics')
    .addServer(`http://localhost:${process.env.PORT ?? 3000}`, 'Local docker-compose run')
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication, document: OpenAPIObject): void {
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/openapi.json',
    yamlDocumentUrl: 'docs/openapi.yaml',
    swaggerOptions: { persistAuthorization: true },
  });
}
