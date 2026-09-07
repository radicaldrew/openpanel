import { useTheme } from '@/components/theme-provider';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import { Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { promqlEditorExtensions } from './promql-extensions';
import { createTrpcPrometheusClient } from './trpc-prometheus-client';

/**
 * The PromQL text box: completion, syntax highlighting and offline linting.
 *
 * Completion is fed by tRPC rather than by an HTTP Prometheus — see
 * trpc-prometheus-client.ts for why that is a tenancy requirement and not a
 * plumbing preference. The extension list itself lives in promql-extensions.ts
 * so it can be assembled, and tested, without a DOM.
 */

interface PromqlCodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Cmd/Ctrl+Enter. Optional: the report editor re-runs on its own. */
  onRun?: () => void;
  projectId: string;
  placeholder?: string;
  className?: string;
}

export function PromqlCodeEditor({
  value,
  onChange,
  onRun,
  projectId,
  placeholder = 'sum(rate(http_requests_total[$__rate_interval]))',
  className,
}: PromqlCodeEditorProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { appTheme } = useTheme();

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef<Compartment | null>(null);

  // Held in refs so a new callback identity on every render does not tear the
  // editor down and lose the cursor mid-word.
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const valueRef = useRef(value);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  valueRef.current = value;

  const trpcRef = useRef(trpc);
  const queryClientRef = useRef(queryClient);
  trpcRef.current = trpc;
  queryClientRef.current = queryClient;

  // The theme reaches the editor through a compartment rather than a rebuild,
  // so the mount effect has to read it without depending on it.
  const isDarkRef = useRef(appTheme === 'dark');
  isDarkRef.current = appTheme === 'dark';

  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const theme = new Compartment();
    themeCompartment.current = theme;

    const { extensions, destroy } = promqlEditorExtensions({
      client: createTrpcPrometheusClient({
        projectId,
        trpc: trpcRef.current,
        queryClient: queryClientRef.current,
      }),
      placeholder: placeholderRef.current,
      themeCompartment: theme,
      isDark: isDarkRef.current,
      onRun: () => onRunRef.current?.(),
      onChange: (next) => {
        valueRef.current = next;
        onChangeRef.current(next);
      },
    });

    const view = new EditorView({
      state: EditorState.create({ doc: valueRef.current, extensions }),
      parent: hostRef.current,
    });

    viewRef.current = view;

    return () => {
      destroy();
      view.destroy();
      viewRef.current = null;
      themeCompartment.current = null;
    };
    // The project is the one input that genuinely changes what the editor
    // knows, and it only changes when the whole page has navigated away anyway.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [projectId]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = themeCompartment.current;

    if (!(view && compartment)) {
      return;
    }

    view.dispatch({
      effects: compartment.reconfigure(appTheme === 'dark' ? [oneDark] : []),
    });
  }, [appTheme]);

  // Take an external change — a pattern applied, the Builder tab writing back —
  // without clobbering what the user is typing. The comparison is what makes
  // that safe: every keystroke round-trips through `onChange` and comes back as
  // a new `value`, and re-dispatching it would reset the selection on every
  // character.
  useEffect(() => {
    const view = viewRef.current;

    if (!view || view.state.doc.toString() === value) {
      return;
    }

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return <div className={cn('min-w-0', className)} ref={hostRef} />;
}
