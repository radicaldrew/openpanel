import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpAuthContext } from '../../auth';
import { registerSeoAiTools } from './ai';
import { registerSeoAuditTools } from './audit';
import { registerSeoBacklinkTools } from './backlinks';
import { registerSeoKeywordTools } from './keywords';
import { registerSeoStatusTools } from './status';
import { registerSeoTrackingTools } from './tracking';

/**
 * SEO module tools (SEO.md §9). Mirrors the `seo` tRPC router surface on top
 * of the same packages/db services. Mutating tools are only registered for
 * root clients; the read tools work for both client types.
 */
export function registerSeoTools(server: McpServer, context: McpAuthContext): void {
  registerSeoStatusTools(server, context);
  registerSeoKeywordTools(server, context);
  registerSeoTrackingTools(server, context);
  registerSeoBacklinkTools(server, context);
  registerSeoAuditTools(server, context);
  registerSeoAiTools(server, context);
}
