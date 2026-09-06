import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon } from 'lucide-react';
import { type AiEngine, shortUrl } from './use-ai';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltiper } from '@/components/ui/tooltip';
import { useNumber } from '@/hooks/use-numer-formatter';
import { useTRPC } from '@/integrations/trpc/react';
import { getChartColor } from '@/utils/theme';

interface Props {
  projectId: string;
  competitors: string[];
}

const ENGINE_COLORS: Record<AiEngine, string> = {
  chat_gpt: getChartColor(0),
  google: getChartColor(1),
};

function ErrorNote({ message }: { message: string }) {
  return <p className="text-destructive text-sm">{message}</p>;
}

function EngineCards({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const number = useNumber();
  const query = useQuery(trpc.seo.ai.aggregate.queryOptions({ projectId }));

  if (query.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (query.isError) {
    return <ErrorNote message={query.error.message} />;
  }
  const data = query.data;
  if (!data) {
    return null;
  }

  return (
    <div className="card grid grid-cols-2 overflow-hidden rounded-md sm:grid-cols-3">
      <div className="col gap-1 border-border border-r px-4 py-3">
        <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
          All engines
        </span>
        <span className="font-mono font-semibold text-2xl tabular-nums">
          {number.short(data.totals.mentions)}
        </span>
        <span className="text-muted-foreground text-xs">
          mentions of {data.domain}
        </span>
      </div>
      {data.engines.map((engine) => (
        <div
          className="col gap-1 border-border border-r px-4 py-3 last:border-r-0"
          key={engine.engine}
        >
          <span className="flex items-center gap-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
            <span
              className="size-2 rounded-sm"
              style={{ background: ENGINE_COLORS[engine.engine] }}
            />
            {engine.label}
          </span>
          <span className="font-mono font-semibold text-2xl tabular-nums">
            {number.short(engine.mentions)}
          </span>
          <Tooltiper content="Estimated monthly volume of the prompts that mention you">
            <span className="text-muted-foreground text-xs">
              {number.short(engine.aiSearchVolume)} prompt volume
            </span>
          </Tooltiper>
        </div>
      ))}
    </div>
  );
}

function ShareOfVoice({ projectId, competitors }: Props) {
  const trpc = useTRPC();
  const number = useNumber();
  const query = useQuery(trpc.seo.ai.shareOfVoice.queryOptions({ projectId }));

  return (
    <div className="card col gap-3 rounded-md p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">Share of voice</h3>
        <span className="text-muted-foreground text-xs">
          {competitors.length === 0
            ? 'Add competitors in Settings → DataForSEO to compare'
            : 'Mentions vs configured competitors'}
        </span>
      </div>
      {query.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : query.isError ? (
        <ErrorNote message={query.error.message} />
      ) : (
        <ul className="col gap-2">
          {query.data?.groups.map((group, index) => (
            <li className="col gap-1" key={group.domain}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-sm"
                    style={{ background: getChartColor(index) }}
                  />
                  <span className={group.isOwn ? 'font-semibold' : ''}>{group.domain}</span>
                  {group.isOwn && (
                    <Badge className="font-normal" variant="outline">
                      you
                    </Badge>
                  )}
                </span>
                <span className="font-mono text-muted-foreground tabular-nums">
                  {number.short(group.mentions)} · {group.share.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, group.share)}%`,
                    background: getChartColor(index),
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TopPages({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const number = useNumber();
  const query = useQuery(trpc.seo.ai.topPages.queryOptions({ projectId }));

  return (
    <div className="card overflow-hidden rounded-md">
      <div className="flex items-center justify-between border-b p-4">
        <h3 className="font-medium text-sm">Top cited pages</h3>
        <span className="text-muted-foreground text-xs">Pages AI answers link to</span>
      </div>
      {query.isLoading ? (
        <Skeleton className="m-4 h-40" />
      ) : query.isError ? (
        <div className="p-4">
          <ErrorNote message={query.error.message} />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead className="text-right">Mentions</TableHead>
              <TableHead className="text-right">ChatGPT</TableHead>
              <TableHead className="text-right">Google AI</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data?.pages.length === 0 && (
              <TableRow>
                <TableCell className="py-8 text-center text-muted-foreground" colSpan={4}>
                  No cited pages yet.
                </TableCell>
              </TableRow>
            )}
            {query.data?.pages.map((page) => (
              <TableRow key={page.url}>
                <TableCell>
                  <a
                    className="inline-flex max-w-[320px] items-center gap-1 truncate hover:underline"
                    href={page.url}
                    rel="noopener"
                    target="_blank"
                  >
                    <span className="truncate">{shortUrl(page.url)}</span>
                    <ExternalLinkIcon className="size-3 shrink-0" />
                  </a>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {number.short(page.mentions)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                  {number.short(page.perEngine.chat_gpt)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                  {number.short(page.perEngine.google)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** Left column: visibility IN AI answers (DataForSEO). */
export function AiMentionsPanel({ projectId, competitors }: Props) {
  return (
    <div className="col gap-4">
      <div>
        <h2 className="font-medium">Visibility in AI answers</h2>
        <p className="text-muted-foreground text-sm">
          How often ChatGPT and Google AI mention your domain, from DataForSEO.
        </p>
      </div>
      <EngineCards projectId={projectId} />
      <ShareOfVoice competitors={competitors} projectId={projectId} />
      <TopPages projectId={projectId} />
    </div>
  );
}
