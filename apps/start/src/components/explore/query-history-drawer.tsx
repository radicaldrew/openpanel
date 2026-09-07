import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useTRPC } from '@/integrations/trpc/react';
import { useDebounceValue } from '@/hooks/use-debounce-value';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';

/**
 * The expressions this user has run on this project.
 *
 * Two ways out of it, because there are two things people come here to do:
 * pick up where they left off — which replaces the row they were editing — and
 * compare two queries side by side, which needs a new row and must not
 * overwrite the one already on screen.
 */

interface QueryHistoryDrawerProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Replace the focused row's expression. */
  onUse: (expr: string) => void;
  /** Add it as another query alongside what is already there. */
  onAdd: (expr: string) => void;
  /** False once the panel is full, which the schema caps at ten. */
  canAdd: boolean;
}

export function QueryHistoryDrawer({
  projectId,
  open,
  onOpenChange,
  onUse,
  onAdd,
  canAdd,
}: QueryHistoryDrawerProps) {
  const trpc = useTRPC();
  const [search, setSearch] = useState('');

  // Debounced because the search is a `contains` against Postgres, not a filter
  // over a list already in the browser — the drawer holds the newest fifty and
  // the match has to run over everything.
  const debouncedSearch = useDebounceValue(search, 300);

  const history = useQuery(
    trpc.observability.queryHistory.queryOptions(
      { projectId, search: debouncedSearch || undefined },
      { enabled: open },
    ),
  );

  const rows = history.data ?? [];

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex w-full flex-col gap-4 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Query history</SheetTitle>
        </SheetHeader>

        <Input
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search your queries"
          value={search}
        />

        <div className="-mx-6 flex-1 overflow-y-auto px-6">
          {history.isLoading && (
            <p className="py-8 text-center text-muted-foreground text-sm">
              Loading…
            </p>
          )}

          {!history.isLoading && rows.length === 0 && (
            <p className="py-8 text-center text-muted-foreground text-sm">
              {search
                ? 'No query matches that.'
                : 'Queries you run show up here.'}
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li
                className="group flex items-start gap-2 rounded-lg border p-2"
                key={row.id}
              >
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    onUse(row.expr);
                    onOpenChange(false);
                  }}
                  type="button"
                >
                  <code className="block break-all font-mono text-xs">
                    {row.expr}
                  </code>
                  <span className="mt-1 block text-muted-foreground text-xs">
                    {formatDistanceToNow(new Date(row.createdAt), {
                      addSuffix: true,
                    })}
                  </span>
                </button>
                <Button
                  aria-label="Add as another query"
                  disabled={!canAdd}
                  icon={PlusIcon}
                  onClick={() => {
                    onAdd(row.expr);
                    onOpenChange(false);
                  }}
                  size="icon"
                  variant="ghost"
                />
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}
