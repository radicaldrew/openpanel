import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIGAPIPE_ERROR_STATUS_TOO_LARGE, GIGAPIPE_ROUTES, GigapipeError, queryRange } from './client';

/**
 * The route allowlist is a security control, not a convenience.
 *
 * gigapipe serves far more than OpenPanel exposes — Elastic `_bulk` write
 * routes, an always-on gRPC OTLP receiver, and (with LOG_DRILLDOWN on) several
 * routes that carry no tenant predicate. A route reaches this list only by
 * being reviewed for whether it can be scoped.
 */
describe('GIGAPIPE_ROUTES', () => {
  const routes = Object.values(GIGAPIPE_ROUTES) as string[];

  it('never includes a route that cannot be tenant-scoped', () => {
    // index/volume takes `targetLabels`, which gigapipe string-interpolates
    // into a LogQL expression and re-parses — a cross-tenant injection with a
    // working proof-of-concept. detected_labels/fields carry no tenant
    // predicate at all.
    for (const forbidden of [
      '/loki/api/v1/index/volume',
      '/loki/api/v1/detected_labels',
      '/loki/api/v1/detected_fields',
      '/_bulk',
      '/api/v2/logs',
      '/influx/api/v2/write',
    ]) {
      expect(routes, forbidden).not.toContain(forbidden);
    }
  });

  it('includes patterns, which IS scopable via its query parameter', () => {
    expect(routes).toContain('/loki/api/v1/patterns');
  });

  it('has no duplicate paths', () => {
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('every route is an absolute path with no interpolation', () => {
    // A path built from user input is how an allowlist stops being one.
    for (const route of routes) {
      expect(route.startsWith('/'), route).toBe(true);
      expect(route.includes('${'), route).toBe(false);
    }
  });
});

/**
 * The response-size ceiling is a memory control, not a UX nicety.
 *
 * A grouped metric query on a high-cardinality label fans out without bound,
 * and the agent picks its own group-by labels — so the ceiling is what stands
 * between a hostile or careless query and the API process parsing a
 * multi-hundred-megabyte matrix into memory.
 */
describe('queryRange response ceiling', () => {
  const config = {
    url: 'http://gigapipe.test',
    username: 'u',
    password: 'p',
  };

  const params = {
    promql: 'up',
    start: new Date('2026-01-01T00:00:00Z'),
    end: new Date('2026-01-01T01:00:00Z'),
    step: '60s',
  };

  function streamed(chunks: Uint8Array[]) {
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      { status: 200 },
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a body under the ceiling', async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ status: 'success', data: { result: [] } }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed([body])),
    );

    await expect(queryRange(params, config)).resolves.toEqual({
      status: 'success',
      data: { result: [] },
    });
  });

  it('gives up past the ceiling instead of buffering the whole body', async () => {
    // 1MB chunks, far more of them than the ceiling allows. If the cap did not
    // work this test would allocate every one of them.
    const chunk = new Uint8Array(1024 * 1024);
    let served = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                served += 1;
                controller.enqueue(chunk);
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(queryRange(params, config)).rejects.toThrow(GigapipeError);
    await expect(queryRange(params, config)).rejects.toMatchObject({
      status: GIGAPIPE_ERROR_STATUS_TOO_LARGE,
    });

    // Bounded: it stopped reading rather than draining an endless stream.
    expect(served).toBeLessThan(200);
  });
});
