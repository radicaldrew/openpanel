import { useQuery } from '@tanstack/react-query';
import { Loader2Icon, SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { AI_ENGINE_OPTIONS, type AiEngine, type AiMentions } from './use-ai';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { cn } from '@/utils/cn';

const MAX_ANSWERS = 25;
const MAX_DOMAINS = 15;

function CitedDomains({ domains }: { domains: AiMentions['citedDomains'] }) {
  if (domains.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No answers cite any source for this prompt yet.
      </p>
    );
  }
  const max = Math.max(...domains.map((domain) => domain.answers), 1);
  return (
    <ul className="col gap-2">
      {domains.slice(0, MAX_DOMAINS).map((domain) => (
        <li className="col gap-1" key={domain.domain}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'truncate font-mono',
                  domain.isOwn && 'font-semibold text-emerald-600 dark:text-emerald-400'
                )}
              >
                {domain.domain}
              </span>
              {domain.isOwn && (
                <Badge className="font-normal" variant="success">
                  you
                </Badge>
              )}
              {domain.isCompetitor && (
                <Badge className="font-normal" variant="outline">
                  competitor
                </Badge>
              )}
            </span>
            <Tooltiper content={`${domain.citations} citation(s) across ${domain.answers} answer(s)`}>
              <span className="font-mono text-muted-foreground tabular-nums">
                {domain.answers}
              </span>
            </Tooltiper>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full',
                domain.isOwn ? 'bg-emerald-500' : 'bg-foreground/40'
              )}
              style={{ width: `${(domain.answers / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Engine + question identifies an answer; the same question can come back
 * twice from one engine, so repeats get a running suffix instead of an
 * array index.
 */
function answerKeys(mentions: AiMentions['mentions']): string[] {
  const seen = new Map<string, number>();
  return mentions.map((mention) => {
    const base = `${mention.engine}:${mention.question}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  });
}

function Answers({ mentions, ownDomain }: { mentions: AiMentions['mentions']; ownDomain: string }) {
  const number = useNumber();
  const shown = mentions.slice(0, MAX_ANSWERS);
  const keys = answerKeys(shown);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Prompt</TableHead>
          <TableHead>Engine</TableHead>
          <TableHead className="text-right">Volume</TableHead>
          <TableHead className="text-right">Sources</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mentions.length === 0 && (
          <TableRow>
            <TableCell className="py-8 text-center text-muted-foreground" colSpan={4}>
              No AI answers matched this prompt.
            </TableCell>
          </TableRow>
        )}
        {shown.map((mention, index) => {
          const citesYou = mention.sources.some(
            (source) =>
              source.domain === ownDomain || source.domain?.endsWith(`.${ownDomain}`)
          );
          return (
            <TableRow key={keys[index]}>
              <TableCell>
                <div className="col gap-1">
                  <span>{mention.question || '—'}</span>
                  {citesYou && (
                    <span>
                      <Badge className="font-normal" variant="success">
                        cites you
                      </Badge>
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {AI_ENGINE_OPTIONS.find((option) => option.value === mention.engine)?.label ??
                  mention.engine}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {mention.aiSearchVolume === null ? '—' : number.short(mention.aiSearchVolume)}
              </TableCell>
              <TableCell className="text-right">
                <Tooltiper
                  content={
                    mention.sources.length === 0
                      ? 'No sources'
                      : mention.sources
                          .map((source) => source.domain ?? source.url ?? '')
                          .filter(Boolean)
                          .join(', ')
                  }
                >
                  <span className="font-mono tabular-nums">{mention.sources.length}</span>
                </Tooltiper>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Enter a prompt → which domains AI answers cite for it. */
export function PromptExplorer({
  projectId,
  ownDomain,
}: {
  projectId: string;
  ownDomain: string;
}) {
  const trpc = useTRPC();
  const [draft, setDraft] = useState('');
  const [engines, setEngines] = useState<AiEngine[]>(
    AI_ENGINE_OPTIONS.map((option) => option.value)
  );
  const [submitted, setSubmitted] = useState<{ prompt: string; engines: AiEngine[] } | null>(
    null
  );

  const query = useQuery(
    trpc.seo.ai.mentions.queryOptions(
      {
        projectId,
        target: { type: 'keyword', value: submitted?.prompt ?? '' },
        engines: submitted?.engines,
        limit: 100,
      },
      { enabled: submitted !== null }
    )
  );

  const toggleEngine = (engine: AiEngine, checked: boolean) => {
    setEngines((current) =>
      checked ? [...new Set([...current, engine])] : current.filter((value) => value !== engine)
    );
  };

  const submit = () => {
    const prompt = draft.trim();
    if (prompt && engines.length > 0) {
      setSubmitted({ prompt, engines });
    }
  };

  return (
    <div className="col gap-4">
      <div>
        <h2 className="font-medium">Prompt explorer</h2>
        <p className="text-muted-foreground text-sm">
          Enter a prompt to see which domains AI answers cite for it. Your own
          domain is highlighted.
        </p>
      </div>

      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="relative min-w-[280px] flex-1">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="best running shoes for flat feet"
            value={draft}
          />
        </div>
        <div className="flex items-center gap-3">
          {AI_ENGINE_OPTIONS.map((option) => (
            <Label className="flex items-center gap-1.5 text-sm" key={option.value}>
              <Checkbox
                checked={engines.includes(option.value)}
                onCheckedChange={(checked) => toggleEngine(option.value, checked === true)}
              />
              {option.label}
            </Label>
          ))}
        </div>
        <Button disabled={!draft.trim() || engines.length === 0 || query.isFetching} type="submit">
          {query.isFetching && <Loader2Icon className="mr-2 size-4 animate-spin" />}
          Explore
        </Button>
      </form>

      {submitted && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="card col gap-3 rounded-md p-4">
            <h3 className="font-medium text-sm">Cited domains</h3>
            {query.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : query.isError ? (
              <p className="text-destructive text-sm">{query.error.message}</p>
            ) : (
              <CitedDomains domains={query.data?.citedDomains ?? []} />
            )}
          </div>
          <div className="card overflow-hidden rounded-md lg:col-span-2">
            <div className="border-b p-4">
              <h3 className="font-medium text-sm">
                Answers for “{submitted.prompt}”
              </h3>
            </div>
            {query.isLoading ? (
              <Skeleton className="m-4 h-40" />
            ) : query.isError ? (
              <p className="p-4 text-destructive text-sm">{query.error.message}</p>
            ) : (
              <Answers mentions={query.data?.mentions ?? []} ownDomain={ownDomain} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
