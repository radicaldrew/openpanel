import crypto from 'node:crypto';
import { stripTrailingSlash } from '@openpanel/common';
import { hashPassword } from '@openpanel/common/server';
import {
  db,
  getClientByIdCached,
  getId,
  getProjectByIdCached,
} from '@openpanel/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '@/utils/errors';

// The event-plane mapping (gtm-platform docs/PLAN-signals-tracking.md, P2).
//
// gtmsrv sets these when it connects a project to a workspace and clears them
// (null) to stop sending. The slug has to pass the publisher's own SLUG_RE
// (apps/worker/src/jobs/event-plane-envelope.ts), or every event from the
// project is parked as unaddressable at drain time instead of refused here.
const GTM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const zGtmTenant = {
  gtmTenantSlug: z.string().regex(GTM_SLUG_RE).nullable().optional(),
  gtmTenantId: z.string().uuid().nullable().optional(),
};

/**
 * Both or neither. A project with one of the two set is unmapped as far as the
 * outbox is concerned (event-outbox.service tenantForProject) and drops every
 * event silently, which is the worst way for a half-applied change to fail.
 */
export function assertGtmTenantPair(body: {
  gtmTenantSlug?: string | null;
  gtmTenantId?: string | null;
}) {
  const slug = body.gtmTenantSlug;
  const id = body.gtmTenantId;
  if (slug === undefined && id === undefined) return;
  if ((slug == null) !== (id == null)) {
    // Checked in the handler rather than with superRefine: these schemas are
    // also the route's OpenAPI description, and a refined schema is not an
    // object schema there.
    throw new HttpError(
      'gtmTenantSlug and gtmTenantId are set together or cleared together',
      { status: 400 },
    );
  }
}

// Validation schemas (exported for use in router)
export const zCreateProject = z.object({
  name: z.string().min(1),
  domain: z.string().url().or(z.literal('')).or(z.null()).optional(),
  cors: z.array(z.string()).default([]),
  crossDomain: z.boolean().optional().default(false),
  types: z
    .array(z.enum(['website', 'app', 'backend']))
    .optional()
    .default([]),
  ...zGtmTenant,
});

export const zUpdateProject = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().url().or(z.literal('')).or(z.null()).optional(),
  cors: z.array(z.string()).optional(),
  crossDomain: z.boolean().optional(),
  allowUnsafeRevenueTracking: z.boolean().optional(),
  ...zGtmTenant,
});

export const zCreateClient = z.object({
  name: z.string().min(1),
  projectId: z.string().optional(),
  type: z.enum(['read', 'write', 'root']).optional().default('write'),
});

export const zUpdateClient = z.object({
  name: z.string().min(1).optional(),
});

export const zCreateReference = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  datetime: z.string(),
});

export const zUpdateReference = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  datetime: z.string().optional(),
});

// Projects CRUD
export async function listProjects(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const projects = await db.project.findMany({
    where: {
      organizationId: request.client!.organizationId,
      deleteAt: null,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  reply.send({ data: projects });
}

export async function getProject(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const project = await db.project.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!project) {
    throw new HttpError('Project not found', { status: 404 });
  }

  reply.send({ data: project });
}

export async function createProject(
  request: FastifyRequest<{ Body: z.infer<typeof zCreateProject> }>,
  reply: FastifyReply
) {
  const { name, domain, cors, crossDomain, types, gtmTenantSlug, gtmTenantId } =
    request.body;
  assertGtmTenantPair(request.body);

  // Generate a default client secret
  const secret = `sec_${crypto.randomBytes(10).toString('hex')}`;
  const clientData = {
    organizationId: request.client!.organizationId,
    name: 'First client',
    type: 'write' as const,
    secret: await hashPassword(secret),
  };

  const project = await db.project.create({
    data: {
      id: await getId('project', name),
      organizationId: request.client!.organizationId,
      name,
      domain: domain ? stripTrailingSlash(domain) : null,
      cors: cors.map((c) => stripTrailingSlash(c)),
      crossDomain: crossDomain ?? false,
      allowUnsafeRevenueTracking: false,
      filters: [],
      types,
      // Mapped at birth when gtmsrv connects a new project, so its first
      // event already reaches the bus.
      ...(gtmTenantSlug && gtmTenantId ? { gtmTenantSlug, gtmTenantId } : {}),
      clients: {
        create: clientData,
      },
    },
    include: {
      clients: {
        select: {
          id: true,
        },
      },
    },
  });

  await Promise.all([
    getProjectByIdCached.clear(project.id),
    ...project.clients.map((client) => getClientByIdCached.clear(client.id)),
  ]);

  reply.send({
    data: {
      ...project,
      client: project.clients[0]
        ? {
            id: project.clients[0].id,
            secret,
          }
        : null,
    },
  });
}

export async function updateProject(
  request: FastifyRequest<{
    Params: { id: string };
    Body: z.infer<typeof zUpdateProject>;
  }>,
  reply: FastifyReply
) {
  const body = request.body;
  assertGtmTenantPair(body);

  // Verify project exists and belongs to organization
  const existing = await db.project.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
    include: {
      clients: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!existing) {
    throw new HttpError('Project not found', { status: 404 });
  }

  const updateData: any = {};
  if (body.name !== undefined) {
    updateData.name = body.name;
  }
  if (body.domain !== undefined) {
    updateData.domain = body.domain
      ? stripTrailingSlash(body.domain)
      : null;
  }
  if (body.cors !== undefined) {
    updateData.cors = body.cors.map((c) => stripTrailingSlash(c));
  }
  if (body.crossDomain !== undefined) {
    updateData.crossDomain = body.crossDomain;
  }
  if (body.allowUnsafeRevenueTracking !== undefined) {
    updateData.allowUnsafeRevenueTracking = body.allowUnsafeRevenueTracking;
  }
  if (body.gtmTenantSlug !== undefined || body.gtmTenantId !== undefined) {
    // Validated as a pair above; written as a pair here.
    updateData.gtmTenantSlug = body.gtmTenantSlug ?? null;
    updateData.gtmTenantId = body.gtmTenantId ?? null;
  }

  const project = await db.project.update({
    where: {
      id: request.params.id,
    },
    data: updateData,
  });

  await Promise.all([
    getProjectByIdCached.clear(project.id),
    ...existing.clients.map((client) => getClientByIdCached.clear(client.id)),
  ]);

  reply.send({ data: project });
}

export async function deleteProject(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const project = await db.project.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!project) {
    throw new HttpError('Project not found', { status: 404 });
  }

  await db.project.update({
    where: {
      id: request.params.id,
    },
    data: {
      deleteAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  await getProjectByIdCached.clear(request.params.id);

  reply.send({ success: true });
}

// Clients CRUD
export async function listClients(
  request: FastifyRequest<{ Querystring: { projectId?: string } }>,
  reply: FastifyReply
) {
  const where: any = {
    organizationId: request.client!.organizationId,
  };

  if (request.query.projectId) {
    // Verify project belongs to organization
    const project = await db.project.findFirst({
      where: {
        id: request.query.projectId,
        organizationId: request.client!.organizationId,
      },
    });

    if (!project) {
      throw new HttpError('Project not found', { status: 404 });
    }

    where.projectId = request.query.projectId;
  }

  const clients = await db.client.findMany({
    where,
    orderBy: {
      createdAt: 'desc',
    },
  });

  reply.send({ data: clients });
}

export async function getClient(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const client = await db.client.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!client) {
    throw new HttpError('Client not found', { status: 404 });
  }

  reply.send({ data: client });
}

export async function createClient(
  request: FastifyRequest<{ Body: z.infer<typeof zCreateClient> }>,
  reply: FastifyReply
) {
  const { name, projectId, type } = request.body;

  // If projectId is provided, verify it belongs to organization
  if (projectId) {
    const project = await db.project.findFirst({
      where: {
        id: projectId,
        organizationId: request.client!.organizationId,
      },
    });

    if (!project) {
      throw new HttpError('Project not found', { status: 404 });
    }
  }

  // Generate secret
  const secret = `sec_${crypto.randomBytes(10).toString('hex')}`;

  const client = await db.client.create({
    data: {
      organizationId: request.client!.organizationId,
      projectId: projectId || null,
      name,
      type: type || 'write',
      secret: await hashPassword(secret),
    },
  });

  await getClientByIdCached.clear(client.id);

  reply.send({
    data: {
      ...client,
      secret, // Return plain secret only once
    },
  });
}

export async function updateClient(
  request: FastifyRequest<{
    Params: { id: string };
    Body: z.infer<typeof zUpdateClient>;
  }>,
  reply: FastifyReply
) {
  // Verify client exists and belongs to organization
  const existing = await db.client.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!existing) {
    throw new HttpError('Client not found', { status: 404 });
  }

  const updateData: any = {};
  if (request.body.name !== undefined) {
    updateData.name = request.body.name;
  }

  const client = await db.client.update({
    where: {
      id: request.params.id,
    },
    data: updateData,
  });

  await getClientByIdCached.clear(client.id);

  reply.send({ data: client });
}

export async function deleteClient(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const client = await db.client.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!client) {
    throw new HttpError('Client not found', { status: 404 });
  }

  await db.client.delete({
    where: {
      id: request.params.id,
    },
  });

  await getClientByIdCached.clear(request.params.id);

  reply.send({ success: true });
}

// References CRUD
export async function listReferences(
  request: FastifyRequest<{ Querystring: { projectId?: string } }>,
  reply: FastifyReply
) {
  const where: any = {};

  if (request.query.projectId) {
    // Verify project belongs to organization
    const project = await db.project.findFirst({
      where: {
        id: request.query.projectId,
        organizationId: request.client!.organizationId,
      },
    });

    if (!project) {
      throw new HttpError('Project not found', { status: 404 });
    }

    where.projectId = request.query.projectId;
  } else {
    // If no projectId, get all projects in org and filter references
    const projects = await db.project.findMany({
      where: {
        organizationId: request.client!.organizationId,
      },
      select: { id: true },
    });

    where.projectId = {
      in: projects.map((p) => p.id),
    };
  }

  const references = await db.reference.findMany({
    where,
    orderBy: {
      createdAt: 'desc',
    },
  });

  reply.send({ data: references });
}

export async function getReference(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const reference = await db.reference.findUnique({
    where: {
      id: request.params.id,
    },
    include: {
      project: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reference) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  if (reference.project.organizationId !== request.client!.organizationId) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  reply.send({ data: reference });
}

export async function createReference(
  request: FastifyRequest<{ Body: z.infer<typeof zCreateReference> }>,
  reply: FastifyReply
) {
  const { projectId, title, description, datetime } = request.body;

  // Verify project belongs to organization
  const project = await db.project.findFirst({
    where: {
      id: projectId,
      organizationId: request.client!.organizationId,
    },
  });

  if (!project) {
    throw new HttpError('Project not found', { status: 404 });
  }

  const reference = await db.reference.create({
    data: {
      projectId,
      title,
      description: description || null,
      date: new Date(datetime),
    },
  });

  reply.send({ data: reference });
}

export async function updateReference(
  request: FastifyRequest<{
    Params: { id: string };
    Body: z.infer<typeof zUpdateReference>;
  }>,
  reply: FastifyReply
) {
  const body = request.body;

  // Verify reference exists and belongs to organization
  const existing = await db.reference.findUnique({
    where: {
      id: request.params.id,
    },
    include: {
      project: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!existing) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  if (existing.project.organizationId !== request.client!.organizationId) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  const updateData: any = {};
  if (body.title !== undefined) {
    updateData.title = body.title;
  }
  if (body.description !== undefined) {
    updateData.description = body.description ?? null;
  }
  if (body.datetime !== undefined) {
    updateData.date = new Date(body.datetime);
  }

  const reference = await db.reference.update({
    where: {
      id: request.params.id,
    },
    data: updateData,
  });

  reply.send({ data: reference });
}

export async function deleteReference(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const reference = await db.reference.findUnique({
    where: {
      id: request.params.id,
    },
    include: {
      project: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reference) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  if (reference.project.organizationId !== request.client!.organizationId) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  await db.reference.delete({
    where: {
      id: request.params.id,
    },
  });

  reply.send({ success: true });
}
