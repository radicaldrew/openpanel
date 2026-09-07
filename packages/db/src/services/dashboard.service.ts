import type { IDashboardVariable } from '@openpanel/validation';

import type { Dashboard, Prisma } from '../prisma-client';
import { db } from '../prisma-client';

export type IServiceDashboard = Dashboard;
export type IServiceDashboards = Prisma.DashboardGetPayload<{
  include: {
    project: true;
    reports: true;
  };
}>[];

export async function getDashboardById(id: string, projectId: string) {
  const dashboard = await db.dashboard.findUnique({
    where: {
      id,
      projectId,
    },
    include: {
      project: true,
    },
  });

  if (!dashboard) {
    return null;
  }

  return dashboard;
}

export function getDashboardsByProjectId(projectId: string) {
  return db.dashboard.findMany({
    where: {
      projectId,
    },
    include: {
      project: true,
      reports: true,
    },
  });
}

export async function listDashboardsCore(input: {
  projectId: string;
  organizationId: string;
}) {
  return db.dashboard.findMany({
    where: { projectId: input.projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, projectId: true },
  });
}

/**
 * A dashboard's variable definitions.
 *
 * Rows created before the column existed hold `[]`, so there is no null case
 * to handle at the call sites — a dashboard without variables and a dashboard
 * that has never heard of them look the same, which is what the default is for.
 */
export function getDashboardVariables(
  dashboard: Pick<Dashboard, 'variables'>,
): IDashboardVariable[] {
  return dashboard.variables ?? [];
}

/**
 * Replaces the whole variable list, like every other editor-backed write here:
 * the editor posts the full set, so a variable it leaves out is one the user
 * deleted. Current VALUES are not stored — they live in the URL (`var_<name>`)
 * so a shared dashboard link reopens on the same selection.
 */
export function updateDashboardVariables(
  id: string,
  variables: IDashboardVariable[],
) {
  return db.dashboard.update({
    where: { id },
    data: { variables },
  });
}
