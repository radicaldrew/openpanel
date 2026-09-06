import { createTRPCRouter } from '../../trpc';
import { seoAiRouter } from './ai';
import { seoAuditRouter } from './audit';
import { seoBacklinksRouter } from './backlinks';
import { seoKeywordsRouter } from './keywords';
import { seoSettingsRouter } from './settings';
import { seoTrackingRouter } from './tracking';


export const seoRouter = createTRPCRouter({
  settings: seoSettingsRouter,
  keywords: seoKeywordsRouter,
  tracking: seoTrackingRouter,
  backlinks: seoBacklinksRouter,
  audit: seoAuditRouter,
  ai: seoAiRouter,
});
