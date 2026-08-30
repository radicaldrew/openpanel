import { verifyPassword } from '@openpanel/common/server';
import type { IServiceClientWithProject } from '@openpanel/db';
import { ClientType, getClientByIdCached } from '@openpanel/db';
import { isValidProjectId } from '@openpanel/gigapipe';
import type { FastifyRequest } from 'fastify';

/**
 * Authenticate a telemetry ingest request.
 *
 * Deliberately separate from `validateSdkRequest`. The analytics ingest path
 * accepts credentials from headers OR the request body, tolerates several
 * legacy header spellings, and has a CORS/origin story because it is called
 * from browsers. None of that applies here: telemetry comes from servers, and
 * every extra way to present a credential is another thing to get wrong.
 *
 * One header, one shape:
 *
 *     Authorization: Bearer <clientId>:<clientSecret>
 *
 * which is what an OTel Collector's `otlphttp` exporter can send with no custom
 * extension.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class TelemetryAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryAuthError';
  }
}

export interface TelemetryPrincipal {
  client: IServiceClientWithProject;
  projectId: string;
}

function parseBearer(header: string | undefined): {
  clientId: string;
  clientSecret: string;
} {
  if (!header) {
    throw new TelemetryAuthError('Missing Authorization header');
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw new TelemetryAuthError('Authorization must be "Bearer <id>:<secret>"');
  }

  // Split on the FIRST colon only: a secret may legitimately contain one.
  const raw = match[1] as string;
  const sep = raw.indexOf(':');
  if (sep <= 0 || sep === raw.length - 1) {
    throw new TelemetryAuthError('Authorization must be "Bearer <id>:<secret>"');
  }

  return {
    clientId: raw.slice(0, sep),
    clientSecret: raw.slice(sep + 1),
  };
}

export async function validateTelemetryRequest(
  req: FastifyRequest,
): Promise<TelemetryPrincipal> {
  const { clientId, clientSecret } = parseBearer(
    req.headers.authorization as string | undefined,
  );

  if (!UUID_RE.test(clientId)) {
    throw new TelemetryAuthError('Client ID must be a valid UUIDv4');
  }

  const client = await getClientByIdCached(clientId);

  if (!client) {
    throw new TelemetryAuthError('Invalid client id');
  }

  // Allow-list, not deny-list. A telemetry endpoint accepts telemetry
  // credentials and nothing else — an analytics `write` client must not be able
  // to push telemetry any more than a telemetry client can write events (see
  // the matching allow-lists in ./auth.ts).
  if (client.type !== ClientType.telemetry) {
    throw new TelemetryAuthError(
      'Client is not a telemetry client. Create one under Settings → Clients.',
    );
  }

  if (!client.secret) {
    throw new TelemetryAuthError('Client has no secret');
  }

  if (!(await verifyPassword(clientSecret, client.secret))) {
    throw new TelemetryAuthError('Invalid client secret');
  }

  if (!client.projectId) {
    throw new TelemetryAuthError('Client has no project');
  }

  // The project id becomes a label value inside every stored series, so it is
  // validated here rather than trusted from the database. A malformed id is a
  // configuration bug, but the failure mode — an unscoped or ambiguous label —
  // is a tenancy one, so it fails closed at the door.
  if (!isValidProjectId(client.projectId)) {
    throw new TelemetryAuthError('Client project id is not usable as a label');
  }

  return { client, projectId: client.projectId };
}
