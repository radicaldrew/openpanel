import { defineConfig } from 'tsdown';
import type { Options } from 'tsdown';

const options: Options = {
  clean: true,
  entry: ['src/index.ts'],
  noExternal: [
    /^@openpanel\/.*$/u,
    /^@\/.*$/u,
    // Bundled, not external. It is a transitive dependency of
    // @openpanel/gigapipe, which is itself bundled -- so at runtime the emitted
    // code sits in apps/*/dist and Node resolves upward from there, never
    // reaching packages/gigapipe/node_modules where pnpm installs it. The
    // parser is pure JS with no runtime dependencies of its own, so inlining it
    // is both correct and cheap.
    /^@prometheus-io\/lezer-promql$/u,
  ],
  external: [
    '@hyperdx/node-opentelemetry',
    'pino',
    'pino-pretty',
    '@node-rs/argon2',
  ],
  sourcemap: true,
  platform: 'node',
  shims: true,
  inputOptions: {
    jsx: 'react',
  },
};

if (process.env.WATCH) {
  options.watch = ['src', '../../packages'];
  options.onSuccess = 'node --enable-source-maps dist/index.js';
  options.minify = false;
}

export default defineConfig(options);
