import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon } from 'lucide-react';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';

const FEATURE_LABELS: Record<string, string> = {
  people_also_ask: 'People also ask',
  featured_snippet: 'Featured snippet',
  video: 'Video',
  images: 'Images',
  local_pack: 'Local pack',
  knowledge_graph: 'Knowledge graph',
  shopping: 'Shopping',
  top_stories: 'Top stories',
  ai_overview: 'AI overview',
  related_searches: 'Related searches',
  paid: 'Ads',
};

function featureLabel(type: string): string {
  return FEATURE_LABELS[type] ?? type.replace(/_/g, ' ');
}

interface Props {
  projectId: string;
  keyword: string | null;
  onClose: () => void;
}

/** Top-10 organic results for one keyword with the tracked domain highlighted. */
export function SerpPreviewSheet({ projectId, keyword, onClose }: Props) {
  const trpc = useTRPC();
  const previewQuery = useQuery(
    trpc.seo.keywords.serpPreview.queryOptions(
      { projectId, keyword: keyword ?? '' },
      { enabled: keyword !== null, staleTime: 6 * 60 * 60 * 1000 }
    )
  );
  const preview = previewQuery.data;

  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={keyword !== null}>
      <SheetContent className="!max-w-xl overflow-y-auto" side="right">
        <SheetHeader>
          <SheetTitle className="font-mono">{keyword}</SheetTitle>
          <SheetDescription>
            {preview
              ? preview.ownPosition
                ? `${preview.domain} ranks #${preview.ownPosition}`
                : `${preview.domain} is not in the top ${preview.results.length || 10}`
              : 'Live Google results for the configured market'}
          </SheetDescription>
        </SheetHeader>

        {previewQuery.isError && (
          <p className="mt-4 text-destructive text-sm">
            {previewQuery.error.message}
          </p>
        )}

        {previewQuery.isLoading && (
          <div className="mt-6 space-y-3">
            {[1, 2, 3, 4, 5].map((index) => (
              <Skeleton className="h-14 w-full" key={index} />
            ))}
          </div>
        )}

        {preview && (
          <div className="mt-6 space-y-6">
            {preview.features.length > 0 && (
              <div>
                <div className="mb-2 font-medium text-muted-foreground text-xs uppercase">
                  SERP features
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {preview.features.map((feature) => (
                    <Badge key={feature} variant="secondary">
                      {featureLabel(feature)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <ol className="space-y-2">
              {preview.results.map((result) => (
                <li
                  className={cn(
                    'rounded-md border p-3',
                    result.isOwnDomain &&
                      'border-emerald-500/60 bg-emerald-500/5'
                  )}
                  key={`${result.rank}-${result.url}`}
                >
                  <div className="flex items-start gap-3">
                    <span className="w-6 shrink-0 font-mono text-muted-foreground text-sm tabular-nums">
                      {result.rank ?? '–'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-muted-foreground text-xs">
                          {result.domain}
                        </span>
                        {result.isOwnDomain && (
                          <Badge variant="success">You</Badge>
                        )}
                      </div>
                      {result.url ? (
                        <a
                          className="mt-0.5 flex items-center gap-1 truncate font-medium text-sm hover:underline"
                          href={result.url}
                          rel="noopener"
                          target="_blank"
                        >
                          <span className="truncate">
                            {result.title ?? result.url}
                          </span>
                          <ExternalLinkIcon className="h-3 w-3 shrink-0 opacity-60" />
                        </a>
                      ) : (
                        <div className="mt-0.5 truncate font-medium text-sm">
                          {result.title}
                        </div>
                      )}
                      {result.description && (
                        <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">
                          {result.description}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
              {preview.results.length === 0 && (
                <li className="text-muted-foreground text-sm">
                  Google returned no organic results for this keyword.
                </li>
              )}
            </ol>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
