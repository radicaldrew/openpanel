import { type Compartment, type Extension, Prec } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import {
  type PrometheusClient,
  PromQLExtension,
} from '@prometheus-io/codemirror-promql';
import { basicSetup } from 'codemirror';

import { variableTolerantLinter } from './promql-lint';

/**
 * The CodeMirror extension list the PromQL editor runs on.
 *
 * Pulled out of the component so it can be built without a DOM. That is not
 * tidiness: the one failure this list can have is a resolver failure — two
 * copies of `@codemirror/state` in the bundle make every `instanceof` check
 * fail and `EditorState.create` throws "Unrecognized extension value in
 * extension set" the first time the editor is opened. A test can only catch
 * that by constructing a state from the REAL list, and a test that assembles
 * its own would pass while this one was broken.
 */

export interface PromqlEditorExtensionsOptions {
  /** Backs completion. See trpc-prometheus-client.ts. */
  client: PrometheusClient;
  placeholder: string;
  /** Reconfigured when the app theme changes, without rebuilding the editor. */
  themeCompartment: Compartment;
  isDark: boolean;
  onRun: () => void;
  onChange: (next: string) => void;
}

export interface PromqlEditorExtensions {
  extensions: Extension[];
  /** Releases the completion strategy's own resources. */
  destroy: () => void;
}

export function promqlEditorExtensions({
  client,
  placeholder,
  themeCompartment,
  isDark,
  onRun,
  onChange,
}: PromqlEditorExtensionsOptions): PromqlEditorExtensions {
  const promql = new PromQLExtension().setComplete({ remote: client });

  // Wrapped rather than replaced: `getLinter()` is the upstream default the
  // constructor installed, and the wrapper delegates to it for every query that
  // has no variables in it.
  promql.setLinter(variableTolerantLinter(promql.getLinter()));

  const extensions: Extension[] = [
    // Ahead of basicSetup so Cmd+Enter is not swallowed by the default keymap's
    // newline binding.
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            onRun();
            // Claimed either way: falling through would insert a newline into a
            // query the user just asked to run.
            return true;
          },
        },
      ]),
    ),
    basicSetup,
    promql.asExtension(),
    cmPlaceholder(placeholder),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChange(update.state.doc.toString());
      }
    }),
    EditorView.theme({
      '&': {
        fontSize: '13px',
        backgroundColor: 'transparent',
      },
      '&.cm-editor': {
        // Tailwind v4 tokens in styles.css are complete colours, not the HSL
        // channel triples the v3 convention wrapped in `hsl()` — passing one
        // through `hsl()` produces an invalid colour and the border silently
        // disappears.
        border: '1px solid var(--border)',
        borderRadius: '6px',
        overflow: 'hidden',
      },
      '&.cm-editor.cm-focused': {
        outline: 'none',
        borderColor: 'var(--ring)',
      },
      '.cm-content': {
        padding: '8px 10px',
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      },
      // A query is one expression, not a program. Line numbers and a fold
      // gutter are noise beside a single line, but `basicSetup` is the only
      // route to the completion extension this app has a dependency on, so they
      // are hidden rather than left out.
      '.cm-gutters': {
        display: 'none',
      },
      '.cm-activeLine': {
        backgroundColor: 'transparent',
      },
      '.cm-tooltip': {
        maxWidth: '32rem',
      },
    }),
    themeCompartment.of(isDark ? [oneDark] : []),
  ];

  return { extensions, destroy: () => promql.destroy() };
}
