import { Compartment, EditorState } from '@codemirror/state';
import type { PrometheusClient } from '@prometheus-io/codemirror-promql';
import { describe, expect, it } from 'vitest';

import { promqlEditorExtensions } from './promql-extensions';

/**
 * Proof that vitest resolves ONE copy of `@codemirror/state`.
 *
 * `@prometheus-io/codemirror-promql` ships a CJS `main` and an ESM `module`
 * with no `exports` map, so without the `resolve.dedupe` +
 * `server.deps.inline` pair in vitest.config.ts its CJS build pulls in a
 * second `@codemirror/state`. CodeMirror compares facets and extensions by
 * identity, so an extension built against one copy is unrecognised by a state
 * built against the other, and `EditorState.create` throws "Unrecognized
 * extension value in extension set".
 *
 * That failure is invisible to every other test in this directory, because
 * they all test pure functions and never construct a state. It would first be
 * seen by a user opening the PromQL editor.
 *
 * The extension list comes from `promqlEditorExtensions` — the same single
 * call site the editor component uses — deliberately. A test that assembled
 * its own list would pass while the editor's real list was broken, which is
 * the whole failure mode being guarded against.
 */

/**
 * A client that records what was asked of it.
 *
 * Completion never runs during `EditorState.create`, so nothing here should be
 * called while the state is being built — the tests assert that rather than
 * assuming it, which is what keeps this a test of the extension list and not
 * of a stub. `destroy` is the exception: the upstream `HybridComplete.destroy`
 * forwards to `prometheusClient?.destroy?.()`, so it is a real part of the
 * teardown contract.
 */
function recordingClient() {
  const calls: string[] = [];

  const client = new Proxy(
    {},
    {
      get(_target, property) {
        const name = String(property);

        return (...args: unknown[]) => {
          calls.push(name);
          // Every PrometheusClient method is promise-returning; answering with
          // an empty result keeps a stray call from throwing for the wrong
          // reason, since `calls` is what the assertion looks at.
          return name === 'destroy' ? undefined : Promise.resolve([]);
        };
      },
    },
  ) as PrometheusClient;

  return { client, calls };
}

const build = (isDark = false) => {
  const { client, calls } = recordingClient();

  return {
    ...promqlEditorExtensions({
      client,
      placeholder: 'Enter a PromQL query',
      themeCompartment: new Compartment(),
      isDark,
      onRun: () => {},
      onChange: () => {},
    }),
    calls,
  };
};

describe('the editor’s real extension list builds a state', () => {
  it('constructs an EditorState without an extension-identity error', () => {
    const { extensions, destroy, calls } = build();

    try {
      const state = EditorState.create({
        doc: 'sum(rate(up[5m]))',
        extensions,
      });

      expect(state.doc.toString()).toBe('sum(rate(up[5m]))');
      // Nothing was fetched to get here, so the state really was built from
      // the extension list rather than from anything the stub supplied.
      expect(calls).toEqual([]);
    } finally {
      destroy();
    }
  });

  it('builds in dark mode too', () => {
    // The theme compartment is the one extension swapped at runtime, so it is
    // worth knowing both branches resolve against the same module instance.
    const { extensions, destroy } = build(true);

    try {
      expect(() =>
        EditorState.create({ doc: 'up', extensions }),
      ).not.toThrow();
    } finally {
      destroy();
    }
  });

  it('applies a transaction, so the state is really live', () => {
    // `EditorState.create` succeeding is necessary but not sufficient: a
    // duplicated `@codemirror/state` can also surface as a facet that never
    // resolves, which only shows up once the state is used.
    const { extensions, destroy } = build();

    try {
      const state = EditorState.create({ doc: 'up', extensions });
      const next = state.update({
        changes: { from: 2, insert: '{job="api"}' },
      }).state;

      expect(next.doc.toString()).toBe('up{job="api"}');
    } finally {
      destroy();
    }
  });
});
