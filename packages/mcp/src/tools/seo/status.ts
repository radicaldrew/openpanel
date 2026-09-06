import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSeoStatus } from '@openpanel/db';
import type { McpAuthContext } from '../../auth';
import { projectIdSchema, resolveProjectId } from '../shared';
import { withSeoErrorHandling } from './shared';

const LOW_BALANCE_USD = 5;

export function registerSeoStatusTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    'seo_status',
    'Check what the SEO module can do for this project: whether DataForSEO is connected (with balance and monthly spend), whether Google Search Console is connected, and the project SEO configuration (tracked domain, market, competitors, schedules). Call this first when another seo_* tool fails or before recommending an SEO action — the `missing` list says exactly what to set up and where.',
    {
      projectId: projectIdSchema(context),
    },
    async ({ projectId: inputProjectId }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const status = await getSeoStatus(projectId);

        const missing: string[] = [];
        if (!status.dfs.configured) {
          missing.push(
            'DataForSEO key: add login + password under Settings → DataForSEO (organization-wide).'
          );
        } else if (status.dfs.balanceUsd !== null && status.dfs.balanceUsd <= 0) {
          missing.push(
            'DataForSEO balance is empty: top up at app.dataforseo.com/billing, then refresh under Settings → DataForSEO.'
          );
        } else if (status.dfs.balanceUsd !== null && status.dfs.balanceUsd < LOW_BALANCE_USD) {
          missing.push(`DataForSEO balance is low ($${status.dfs.balanceUsd.toFixed(2)}).`);
        }
        if (
          status.dfs.spendCapUsd !== null &&
          status.dfs.monthlySpendUsd >= status.dfs.spendCapUsd
        ) {
          missing.push(
            `Monthly DataForSEO spend cap reached ($${status.dfs.monthlySpendUsd.toFixed(2)} of $${status.dfs.spendCapUsd.toFixed(2)}); scheduled jobs are paused until it is raised under Settings → DataForSEO.`
          );
        }
        if (!status.gsc.connected) {
          missing.push(
            'Google Search Console: connect under Settings → Search Console to enable GSC queries, seeding tracked keywords from GSC and the GSC position overlay.'
          );
        }
        if (!status.config?.domain) {
          missing.push(
            'Project SEO config: set the domain, country and language under Settings → DataForSEO (project section) or in any SEO tab.'
          );
        }

        return {
          projectId,
          ready: {
            keywordResearch: status.dfs.configured && Boolean(status.config?.domain),
            rankTracking: status.dfs.configured && Boolean(status.config?.domain),
            backlinks: status.dfs.configured && Boolean(status.config?.domain),
            siteAudit: status.dfs.configured && Boolean(status.config?.domain),
            aiVisibility: status.dfs.configured && Boolean(status.config?.domain),
            searchConsole: status.gsc.connected,
          },
          dataforseo: {
            configured: status.dfs.configured,
            login: status.dfs.login,
            balanceUsd: status.dfs.balanceUsd,
            balanceAt: status.dfs.balanceAt,
            monthlySpendUsd: Math.round(status.dfs.monthlySpendUsd * 10_000) / 10_000,
            spendCapUsd: status.dfs.spendCapUsd,
            lastError: status.dfs.lastError,
          },
          searchConsole: status.gsc,
          config: status.config,
          missing,
        };
      })
  );
}
