import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon, PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatUsd } from './audit-status';
import { WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';

type AuditDefaults = RouterOutputs['seo']['audit']['list']['defaults'];

const PAGE_CHOICES = [100, 250, 500, 1000, 2500, 5000, 10_000];

interface Props {
  projectId: string;
  domain: string;
  defaults: AuditDefaults;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabledReason?: string | null;
}

export function RunAuditDialog({
  projectId,
  domain,
  defaults,
  open,
  onOpenChange,
  disabledReason,
}: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [maxPages, setMaxPages] = useState(defaults.maxPages);
  const [enableJavascript, setEnableJavascript] = useState(false);

  const start = useMutation(
    trpc.seo.audit.start.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        toast.success('Audit started', {
          description: `Crawling up to ${result.audit.maxPages.toLocaleString()} pages of ${domain}.`,
        });
        queryClient.invalidateQueries(trpc.seo.audit.list.pathFilter());
        onOpenChange(false);
      },
    })
  );

  const choices = PAGE_CHOICES.filter(
    (value) => value >= defaults.minPages && value <= defaults.maxPagesLimit
  );
  if (!choices.includes(maxPages)) {
    choices.push(maxPages);
    choices.sort((a, b) => a - b);
  }
  const perPage = enableJavascript ? defaults.pricePerPageJsUsd : defaults.pricePerPageUsd;
  const estimate = maxPages * perPage;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Run site audit</DialogTitle>
          <DialogDescription>
            Crawls <span className="font-mono">{domain}</span> with DataForSEO On-Page and
            checks every page for technical SEO issues.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <WithLabel
            info="DataForSEO bills per crawled page. Small sites stop early when there is nothing left to crawl."
            label="Maximum pages"
          >
            <Select
              onValueChange={(value) => setMaxPages(Number(value))}
              value={String(maxPages)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value.toLocaleString()} pages
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WithLabel>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
            <Checkbox
              checked={enableJavascript}
              className="mt-0.5"
              onCheckedChange={(checked) => setEnableJavascript(checked === true)}
            />
            <span className="text-sm">
              <span className="font-medium">Render JavaScript</span>
              <span className="block text-muted-foreground text-xs">
                Needed for client-side rendered sites. Slower and about four times the
                price per page.
              </span>
            </span>
          </label>

          <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Estimated cost</span>
            <span className="font-mono tabular-nums">
              up to {formatUsd(estimate)}
            </span>
          </div>

          {disabledReason && (
            <p className="text-destructive text-sm">{disabledReason}</p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={start.isPending || !!disabledReason}
            onClick={() => start.mutate({ projectId, maxPages, enableJavascript })}
          >
            {start.isPending ? (
              <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlayIcon className="mr-2 h-4 w-4" />
            )}
            Start audit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
