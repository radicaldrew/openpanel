import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type IChartEventItem,
  isMetricChartType,
  METRIC_CHART_TYPES,
  zChartEventItem,
  zChartSeries,
  zReportInput,
} from './index';

/**
 * These cover the series discriminator specifically. An LLM writing a report
 * omits `type` on event series (see the comment on `zChartEventItem`), and
 * before the preprocess every such `generate_report` / `create_report` call
 * died on `No matching discriminator` — an error the agent loop could not
 * repair, surfacing to the user as a repeating "An error occurred".
 */

const baseReport = {
  projectId: 'proj_1',
  chartType: 'linear' as const,
  interval: 'day' as const,
  range: 'custom' as const,
  startDate: '2024-01-01',
  endDate: '2024-01-31',
};

describe('zChartEventItem', () => {
  it('accepts an explicit event series', () => {
    const parsed = zChartEventItem.parse({
      type: 'event',
      name: 'screen_view',
      segment: 'user',
      filters: [],
    });

    expect(parsed).toMatchObject({
      type: 'event',
      name: 'screen_view',
      segment: 'user',
    });
  });

  it('accepts an explicit formula series', () => {
    const parsed = zChartEventItem.parse({
      type: 'formula',
      formula: 'A / B * 100',
      hideSeries: ['A', 'B'],
    });

    expect(parsed).toMatchObject({
      type: 'formula',
      formula: 'A / B * 100',
      hideSeries: ['A', 'B'],
    });
  });

  it('defaults an omitted type to event and still applies the field defaults', () => {
    const parsed = zChartEventItem.parse({ name: 'screen_view' });

    expect(parsed).toEqual({
      type: 'event',
      name: 'screen_view',
      segment: 'event',
      filters: [],
    });
  });

  it('routes a type-less item carrying a formula to the formula branch', () => {
    // Stamping 'event' unconditionally would reject this with a misleading
    // "name is required" instead of parsing the formula the model meant.
    const parsed = zChartEventItem.parse({ formula: 'A / B' });

    expect(parsed).toEqual({ type: 'formula', formula: 'A / B' });
  });

  it('still reports a field-level issue for a malformed event', () => {
    // The discriminated union has to survive: a bad event must come back as
    // "name is wrong", not as both branches' errors, or the agent's
    // self-correction loop has nothing actionable to fix.
    const result = zChartEventItem.safeParse({ type: 'event', name: 42 });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'name',
    ]);
  });

  it('rejects an unknown type outright', () => {
    expect(
      zChartEventItem.safeParse({ type: 'cohort', name: 'x' }).success,
    ).toBe(false);
  });
});

describe('zReportInput series', () => {
  it('parses a mixed series where only the formula names its type', () => {
    const result = zReportInput.safeParse({
      ...baseReport,
      series: [
        { id: 'A', name: 'signup_started', segment: 'user', filters: [] },
        { id: 'B', name: 'signup_completed', segment: 'user', filters: [] },
        { id: 'C', type: 'formula', formula: 'B / A * 100' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data?.series.map((item: IChartEventItem) => item.type)).toEqual(
      ['event', 'event', 'formula'],
    );
  });

  it('keeps an explicitly typed series working unchanged', () => {
    const result = zReportInput.safeParse({
      ...baseReport,
      series: [
        { id: 'A', type: 'event', name: 'screen_view', filters: [] },
        { id: 'B', type: 'formula', formula: 'A * 2' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data?.series.map((item: IChartEventItem) => item.type)).toEqual(
      ['event', 'formula'],
    );
  });
});

describe('series JSON Schema', () => {
  /**
   * The MCP server and the chat agent both hand the model a JSON Schema derived
   * from this union. Flattening the union — or losing the `const` on `type` —
   * would stop telling the model that a formula series exists at all, so this
   * guards the tool definition rather than the parser.
   */
  type SeriesJsonSchema = {
    items: { oneOf: { properties: { type: { const: string } } }[] };
  };

  it('still emits both branches with a const discriminator', () => {
    const schema = z.toJSONSchema(zChartSeries, {
      target: 'draft-7',
      io: 'input',
    }) as unknown as SeriesJsonSchema;

    expect(schema.items.oneOf).toHaveLength(2);
    expect(
      schema.items.oneOf.map((branch) => branch.properties.type.const),
    ).toEqual(['event', 'formula']);
  });
});

describe('METRIC_CHART_TYPES', () => {
  /**
   * The chat agent (`generate_report` / `save_report`) and the report editor
   * each narrowed the metric chart types independently and disagreed — one
   * offered bar/pie, the other histogram. Both lists are now this one, so this
   * guards the agreement rather than the values: a type added here without a
   * path through `executeChart` saves a panel that renders nothing and reports
   * no error.
   */
  it('lists exactly the types that reach the metrics engine', () => {
    expect([...METRIC_CHART_TYPES]).toEqual([
      'linear',
      'area',
      'histogram',
      'metric',
    ]);
  });

  it('rejects the aggregate-engine and events-only chart types', () => {
    for (const chartType of [
      'bar',
      'pie',
      'funnel',
      'retention',
      'conversion',
      'sankey',
      'map',
    ] as const) {
      expect(isMetricChartType(chartType)).toBe(false);
    }
  });

  it('accepts every type it lists', () => {
    for (const chartType of METRIC_CHART_TYPES) {
      expect(isMetricChartType(chartType)).toBe(true);
    }
  });
});
