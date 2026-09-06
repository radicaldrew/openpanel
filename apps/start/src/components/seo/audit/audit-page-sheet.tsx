import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon, GaugeIcon, Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { SEVERITY_BADGE, scoreClass } from './audit-status';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';

type Device = 'mobile' | 'desktop';

interface Props {
  projectId: string;
  auditId: string;
  url: string | null;
  onClose: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-xs">{children}</span>
    </div>
  );
}

/** One crawled page: metadata, the checks it failed, and optional Lighthouse. */
export function AuditPageSheet({ projectId, auditId, url, onClose }: Props) {
  const trpc = useTRPC();
  const [device, setDevice] = useState<Device>('mobile');

  const pageQuery = useQuery(
    trpc.seo.audit.page.queryOptions(
      { projectId, auditId, url: url ?? '' },
      { enabled: url !== null, staleTime: Number.POSITIVE_INFINITY }
    )
  );

  const lighthouse = useMutation(
    trpc.seo.audit.lighthouse.mutationOptions({ onError: handleError })
  );
  const report = lighthouse.data;
  const page = pageQuery.data;

  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={url !== null}>
      <SheetContent className="!max-w-xl overflow-y-auto" side="right">
        <SheetHeader>
          <SheetTitle className="break-all font-mono text-sm">{url}</SheetTitle>
          <SheetDescription>
            {page ? `${page.issues.length} issue${page.issues.length === 1 ? '' : 's'} on this page` : 'Crawl details'}
          </SheetDescription>
        </SheetHeader>

        {pageQuery.isLoading && (
          <div className="mt-6 space-y-3">
            {[1, 2, 3].map((index) => (
              <Skeleton className="h-12 w-full" key={index} />
            ))}
          </div>
        )}
        {pageQuery.isError && (
          <p className="mt-4 text-destructive text-sm">{pageQuery.error.message}</p>
        )}

        {page && (
          <div className="mt-6 space-y-6">
            <div className="flex items-center gap-4">
              <div className={cn('font-mono font-semibold text-3xl', scoreClass(page.onpageScore))}>
                {Math.round(page.onpageScore)}
              </div>
              <div className="text-muted-foreground text-xs">On-page score</div>
              <a
                className="ml-auto flex items-center gap-1 text-xs hover:underline"
                href={page.url}
                rel="noopener"
                target="_blank"
              >
                Open page <ExternalLinkIcon className="h-3 w-3" />
              </a>
            </div>

            <div className="divide-y rounded-md border px-3">
              <Row label="Status">{page.statusCode || '–'}</Row>
              <Row label="Title">{page.title || <em className="text-muted-foreground">none</em>}</Row>
              <Row label="Description">
                {page.metaDescription || <em className="text-muted-foreground">none</em>}
              </Row>
              <Row label="H1">{page.h1 || <em className="text-muted-foreground">none</em>}</Row>
              <Row label="Canonical">{page.canonical || '–'}</Row>
              <Row label="Indexable">{page.isIndexable ? 'yes' : 'no'}</Row>
              <Row label="Words">{page.wordCount.toLocaleString()}</Row>
              <Row label="Load time">{page.loadTimeMs ? `${page.loadTimeMs} ms` : '–'}</Row>
              <Row label="Size">{page.sizeBytes ? `${Math.round(page.sizeBytes / 1024)} KB` : '–'}</Row>
              <Row label="Links">
                {page.internalLinks} internal · {page.externalLinks} external
              </Row>
            </div>

            <div>
              <div className="mb-2 font-medium text-muted-foreground text-xs uppercase">Checks</div>
              {page.issues.length === 0 ? (
                <p className="text-muted-foreground text-sm">Every check passed.</p>
              ) : (
                <ul className="space-y-2">
                  {page.issues.map((issue) => (
                    <li className="rounded-md border p-3" key={issue.key}>
                      <div className="flex items-center gap-2">
                        <Badge variant={SEVERITY_BADGE[issue.severity]}>{issue.severity}</Badge>
                        <span className="font-medium text-sm">{issue.label}</span>
                      </div>
                      <p className="mt-1 text-muted-foreground text-xs">{issue.description}</p>
                      <p className="mt-1 text-xs">
                        <span className="font-medium">Fix: </span>
                        {issue.howToFix}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="font-medium text-muted-foreground text-xs uppercase">Lighthouse</div>
                <div className="flex items-center gap-2">
                  <Select onValueChange={(value) => setDevice(value as Device)} value={device}>
                    <SelectTrigger className="w-28" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mobile">Mobile</SelectItem>
                      <SelectItem value="desktop">Desktop</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={lighthouse.isPending}
                    onClick={() => lighthouse.mutate({ projectId, url: page.url, device })}
                    size="sm"
                    variant="outline"
                  >
                    {lighthouse.isPending ? (
                      <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <GaugeIcon className="mr-2 h-4 w-4" />
                    )}
                    Run Lighthouse
                  </Button>
                </div>
              </div>
              {!(report || lighthouse.isPending) && (
                <p className="text-muted-foreground text-xs">
                  Runs a live Lighthouse audit through DataForSEO (billed, cached for 24 hours).
                </p>
              )}
              {lighthouse.isPending && (
                <p className="text-muted-foreground text-xs">This usually takes 20–60 seconds…</p>
              )}
              {report && (
                <div className="space-y-3">
                  <div className="grid grid-cols-4 gap-2">
                    {(
                      [
                        ['performance', 'Perf'],
                        ['accessibility', 'A11y'],
                        ['best-practices', 'Best'],
                        ['seo', 'SEO'],
                      ] as const
                    ).map(([key, label]) => {
                      const score = report.scores[key];
                      const rounded = score === null ? null : Math.round(score * 100);
                      return (
                        <div className="rounded-md border p-2 text-center" key={key}>
                          <div className={cn('font-mono font-semibold text-lg', scoreClass(rounded))}>
                            {rounded ?? '–'}
                          </div>
                          <div className="text-muted-foreground text-xs">{label}</div>
                        </div>
                      );
                    })}
                  </div>
                  {report.issues.length > 0 && (
                    <ul className="space-y-1">
                      {report.issues.slice(0, 8).map((issue) => (
                        <li className="text-xs" key={issue.auditKey}>
                          <span className="font-medium">{issue.title}</span>
                          {issue.displayValue && (
                            <span className="text-muted-foreground"> · {issue.displayValue}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
