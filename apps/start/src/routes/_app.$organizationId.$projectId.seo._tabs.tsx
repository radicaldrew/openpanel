import { createFileRoute, Outlet, useRouter } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRangePageContext } from '@/hooks/use-page-context-helpers';
import { usePageTabs } from '@/hooks/use-page-tabs';
import { createProjectTitle } from '@/utils/title';

export const Route = createFileRoute('/_app/$organizationId/$projectId/seo/_tabs')(
  {
    component: Component,
    head: () => {
      return {
        meta: [
          {
            title: createProjectTitle('SEO'),
          },
        ],
      };
    },
  }
);

const SEO_TABS = [
  { id: 'index', label: 'Search Console' },
  { id: 'keywords', label: 'Keywords' },
  { id: 'rankings', label: 'Rankings' },
  { id: 'backlinks', label: 'Backlinks' },
  { id: 'audit', label: 'Site Audit' },
  { id: 'ai', label: 'AI Visibility' },
];

function Component() {
  const router = useRouter();
  useRangePageContext('seo');

  const { activeTab, tabs } = usePageTabs(SEO_TABS);

  const handleTabChange = (tabId: string) => {
    router.navigate({
      from: Route.fullPath,
      to:
        tabId === 'index'
          ? '/$organizationId/$projectId/seo'
          : `/$organizationId/$projectId/seo/${tabId}`,
    });
  };

  return (
    <div className="container p-8">
      <PageHeader
        description="Search Console, keyword research, rank tracking, backlinks, site audits and AI visibility"
        title="SEO"
      />

      <Tabs
        className="mt-2 mb-8"
        onValueChange={handleTabChange}
        value={activeTab}
      >
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}
