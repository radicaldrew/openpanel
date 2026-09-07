import { ButtonContainer } from '@/components/button-container';
import { WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { handleErrorToastOptions, useTRPC } from '@/integrations/trpc/react';
import { popModal } from '@/modals';
import { ModalContent, ModalHeader } from '@/modals/Modal/Container';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { defaultRangeEnd } from './annotation-utils';

/** `datetime-local` wants `YYYY-MM-DDTHH:mm`, in LOCAL time. */
function toLocalInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): Date {
  return new Date(value);
}

export type CreateAnnotationProps = {
  projectId: string;
  dashboardId: string;
  /** The bucket that was clicked. */
  time: Date;
  /** The report's interval, for the range prefill. */
  interval: string;
};

/**
 * Create an annotation at a point on a chart.
 *
 * Opened by Cmd/Ctrl+click on a metric chart, so the time is already known —
 * which is the whole reason this is a modal rather than a settings form. The
 * time is still editable, because the click lands on a bucket and the deploy
 * happened at a moment inside it.
 */
export default function CreateAnnotation({
  projectId,
  dashboardId,
  time,
  interval,
}: CreateAnnotationProps) {
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');
  const [isRange, setIsRange] = useState(false);
  const [start, setStart] = useState(() => toLocalInput(time));
  const [end, setEnd] = useState(() =>
    toLocalInput(defaultRangeEnd(time, interval)),
  );
  // Global by default: a deploy is a fact about the project, not about the
  // dashboard someone happened to be looking at when they recorded it.
  const [isGlobal, setIsGlobal] = useState(true);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const mutation = useMutation(
    trpc.annotation.create.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        toast('Annotation added');
        queryClient.invalidateQueries(trpc.annotation.list.pathFilter());
        popModal();
      },
    }),
  );

  const submit = () => {
    const startDate = fromLocalInput(start);
    const endDate = isRange ? fromLocalInput(end) : null;

    if (Number.isNaN(startDate.getTime())) {
      toast.error('That start time is not a valid date');
      return;
    }

    if (endDate && (Number.isNaN(endDate.getTime()) || endDate <= startDate)) {
      // A zero-width or backwards span draws nothing at all, so this would
      // otherwise save successfully and then appear not to have worked.
      toast.error('The end time has to be after the start time');
      return;
    }

    mutation.mutate({
      projectId,
      dashboardId: isGlobal ? null : dashboardId,
      time: startDate.toISOString(),
      timeEnd: endDate ? endDate.toISOString() : null,
      text: text.trim(),
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ''),
    });
  };

  return (
    <ModalContent>
      <ModalHeader
        title="Add annotation"
        text="Mark a deploy, an incident or a note on this project's charts."
      />

      <div className="flex flex-col gap-4">
        <WithLabel label="Note">
          <Textarea
            rows={2}
            autoFocus
            value={text}
            placeholder="Deployed v2.4.0"
            onChange={(e) => setText(e.target.value)}
          />
        </WithLabel>

        <WithLabel label="Tags" info="Comma separated, e.g. deploy, api">
          <Input
            value={tags}
            placeholder="deploy, api"
            onChange={(e) => setTags(e.target.value)}
          />
        </WithLabel>

        <div className="flex gap-3">
          <WithLabel label="Time" className="flex-1">
            <Input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </WithLabel>

          {isRange && (
            <WithLabel label="End" className="flex-1">
              <Input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </WithLabel>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={isRange}
            onCheckedChange={(checked) => setIsRange(checked === true)}
          />
          This covers a period of time
        </label>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={isGlobal}
            onCheckedChange={(checked) => setIsGlobal(checked === true)}
          />
          Show on every dashboard in this project
        </label>
      </div>

      <ButtonContainer>
        <Button type="button" variant="outline" onClick={() => popModal()}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={submit}
          disabled={mutation.isPending || text.trim() === ''}
        >
          Add
        </Button>
      </ButtonContainer>
    </ModalContent>
  );
}
