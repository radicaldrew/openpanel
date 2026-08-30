import { describe, expect, it } from 'vitest';
import { GIGAPIPE_ROUTES } from './client';

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
