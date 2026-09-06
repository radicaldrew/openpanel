import { useMutation } from '@tanstack/react-query';
import { Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useInvalidateTracking } from './use-tracking';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { handleError, useTRPC } from '@/integrations/trpc/react';

interface Props {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function parseKeywordInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
}

export function parseTagInput(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function AddKeywordsDialog({ projectId, open, onOpenChange }: Props) {
  const trpc = useTRPC();
  const invalidate = useInvalidateTracking();
  const [keywords, setKeywords] = useState('');
  const [tags, setTags] = useState('');

  const add = useMutation(
    trpc.seo.tracking.add.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        invalidate();
        setKeywords('');
        setTags('');
        onOpenChange(false);
        const existing =
          result.existing.length > 0
            ? `, ${result.existing.length} already tracked`
            : '';
        toast.success(`Tracking ${result.added.length} new keyword(s)${existing}`);
      },
    })
  );

  const parsed = parseKeywordInput(keywords);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add keywords</DialogTitle>
          <DialogDescription>
            One per line or comma-separated. Search volume and difficulty are
            fetched automatically; positions arrive with the next check.
          </DialogDescription>
        </DialogHeader>
        <div className="col gap-4">
          <div className="col gap-1.5">
            <Label htmlFor="seo-add-keywords">Keywords</Label>
            <Textarea
              id="seo-add-keywords"
              onChange={(event) => setKeywords(event.target.value)}
              placeholder={'running shoes\nbest trail runners'}
              rows={8}
              value={keywords}
            />
            <span className="text-muted-foreground text-xs">
              {parsed.length} keyword(s)
            </span>
          </div>
          <div className="col gap-1.5">
            <Label htmlFor="seo-add-tags">Tags (optional)</Label>
            <Input
              id="seo-add-tags"
              onChange={(event) => setTags(event.target.value)}
              placeholder="brand, blog"
              value={tags}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={parsed.length === 0 || add.isPending}
            onClick={() =>
              add.mutate({
                projectId,
                keywords: parsed,
                tags: parseTagInput(tags),
                source: 'manual',
              })
            }
          >
            {add.isPending && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            Track {parsed.length > 0 ? parsed.length : ''} keyword(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
