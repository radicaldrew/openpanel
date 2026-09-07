import { createRequire } from 'node:module';
import path from 'node:path';

import viteReact from '@vitejs/plugin-react';
import viteTsConfigPaths from 'vite-tsconfig-paths';
import { type UserConfig, defineConfig } from 'vitest/config';

/**
 * Vitest config for apps/start, deliberately separate from vite.config.ts.
 *
 * WHY THIS FILE EXISTS
 *
 * A `test` key in vite.config.ts has no effect. That file's default export
 * goes through `wrapVinxiConfigWithSentry`, which returns a new config object
 * without it — a bogus `test.include` there still ran every suite. So the only
 * place test config can actually live is a config file vitest reads directly.
 * Vitest prefers `vitest.config.ts` over `vite.config.ts`, so this replaces it
 * wholesale for test runs, which is why the two plugins the suites depend on
 * are repeated below rather than inherited.
 *
 * Nothing from vite.config.ts's build pipeline is needed here — no Cloudflare
 * plugin, no Nitro, no TanStack Start — so the `NITRO=1` in the `test` script
 * is now redundant. It is kept because it is in people's fingers and in test
 * file headers, and it is harmless.
 */

const require_ = createRequire(import.meta.url);

/**
 * `@prometheus-io/codemirror-promql`, forced onto its ESM build.
 *
 * THE BUG: constructing a real `EditorState` with the PromQL extensions threw
 * `Unrecognized extension value in extension set`. CodeMirror flattens an
 * extension set with `instanceof` checks (`FacetProvider`, `StateField`, …)
 * and throws on anything it does not recognise, so a `FacetProvider` built by
 * a different copy of `@codemirror/state` falls through to that error.
 *
 * THE CAUSE: not two versions — pnpm links the app and codemirror-promql to
 * the same `@codemirror/state@6.5.4` directory. It is ONE package loaded twice
 * in two formats. `@codemirror/state` ships
 * `exports: { import: dist/index.js, require: dist/index.cjs }`, and
 * codemirror-promql has a CJS `main`, an ESM `module`, and no `exports` map.
 * Taking the CJS entry means its `require('@codemirror/state')` resolves
 * through the `require` condition to `dist/index.cjs`, while the app holds
 * `dist/index.js`. Two module instances, two `FacetProvider` classes, every
 * `instanceof` between them false.
 *
 * THE FIX: alias the package to its ESM build, so its imports resolve through
 * the `import` condition onto the same files the app already uses.
 *
 * WHAT DID NOT WORK, so nobody repeats it: `server.deps.inline` (as a regex,
 * as exact strings, extended to `@codemirror/*` and `@lezer/*`, and even
 * `inline: true`), and `resolve.mainFields` preferring `module`. None of them
 * moved the resolution — the entry point is chosen before any of that applies.
 * Deduping the CodeMirror packages does not help either, and deduping the ones
 * apps/start does not declare directly (`@codemirror/language`,
 * `@codemirror/autocomplete`, `@codemirror/lint`, `@lezer/*`) actively breaks
 * the run: under pnpm's strict layout they are not in the project's own
 * node_modules, and forcing root resolution fails with "Cannot find package".
 *
 * Proven by `src/components/promql/promql-extensions.test.ts`, which builds
 * the editor's real extension list and constructs a state from it. That test
 * fails without this alias and passes with it; keep the two together.
 */
function promqlEsmEntry(): string {
  const cjsEntry = require_.resolve('@prometheus-io/codemirror-promql');
  const marker = `${path.sep}dist${path.sep}`;
  const distAt = cjsEntry.indexOf(marker);

  if (distAt === -1) {
    throw new Error(
      `Expected @prometheus-io/codemirror-promql to resolve inside dist/, got ${cjsEntry}`,
    );
  }

  return path.join(cjsEntry.slice(0, distAt), 'dist', 'esm', 'index.js');
}

/**
 * Typed through vitest's own `UserConfig` rather than left to inference.
 *
 * Two majors of vite are installed: `@vitejs/plugin-react` and
 * `vite-tsconfig-paths` resolve vite 7 and return its `Plugin`, while vitest
 * 3.1 pins vite 6, so `defineConfig` wants vite 6's. The two are structurally
 * incompatible over `hotUpdate`'s `this`. Importing `PluginOption` from `vite`
 * does not help — it resolves to vite 7, the wrong side of the mismatch — so
 * the assertion is against the type this call actually expects.
 *
 * Runtime is unaffected: the plugin objects are identical either way, and both
 * majors' hooks are the same shape.
 */
const plugins = [
  // The `@/…` alias every suite imports through.
  viteTsConfigPaths({ projects: ['./tsconfig.json'] }),
  // JSX for the component suites (seo-gate, annotations-layer).
  viteReact(),
] as unknown as UserConfig['plugins'];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      '@prometheus-io/codemirror-promql': promqlEsmEntry(),
    },
  },
  test: {
    // Suites opt into jsdom with a `// @vitest-environment jsdom` pragma;
    // everything else is a pure module and should not pay for a DOM.
    environment: 'node',
  },
});
