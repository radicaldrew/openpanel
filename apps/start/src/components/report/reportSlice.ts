import type { PayloadAction } from '@reduxjs/toolkit';
import { createSlice } from '@reduxjs/toolkit';

import { createPanelQuery, nextRefId } from '@/components/promql/panel-query';
import { shortId } from '@openpanel/common';
import {
  getDefaultIntervalByDates,
  getDefaultIntervalByRange,
  isHourIntervalEnabledByRange,
  isMinuteIntervalEnabledByRange,
} from '@openpanel/constants';
import type {
  IChartBreakdown,
  IChartEventFilter,
  IChartEventItem,
  IChartLineType,
  IChartMetric,
  IChartRange,
  IChartType,
  IInterval,
  IMetricQuery,
  IPanelQuery,
  IReport,
  IReportDataSource,
  IReportOptions,
  UnionOmit,
  zCriteria,
} from '@openpanel/validation';
import { isMetricChartType } from '@openpanel/validation';
import type { z } from 'zod';

type InitialState = IReport & {
  id?: string;
  dirty: boolean;
  ready: boolean;
  startDate: string | null;
  endDate: string | null;
  /**
   * The metric query of a report that has been switched back to events.
   *
   * Editor-only, never persisted: `refineReportDataSource` rejects a report
   * that carries a metricQuery while `dataSource` is not `'metrics'`, so unlike
   * the event series — which an events-turned-metrics report keeps lying
   * dormant in `series` — the query cannot simply stay put. Holding it aside
   * here is what makes the toggle a look rather than a commitment.
   */
  stashedMetricQuery?: IMetricQuery;
  /**
   * The panel queries of a report that has been switched back to events.
   *
   * Same reason as `stashedMetricQuery` above, for the same refinement: an
   * events report carrying `metricQueries` is rejected by
   * `refineReportDataSource`, so the list has to leave `metricQueries` rather
   * than sit there dormant the way `series` does.
   */
  stashedMetricQueries?: IPanelQuery[];
  // Always arrays in state (initialState + setReport guarantee it) so the
  // reducers below can push/map without optional-chaining.
  globalFilters: IChartEventFilter[];
  metricQueries: IPanelQuery[];
};

// First approach: define the initial state using that type
const initialState: InitialState = {
  ready: false,
  dirty: false,
  projectId: '',
  name: '',
  chartType: 'linear',
  lineType: 'monotone',
  interval: 'day',
  breakdowns: [],
  globalFilters: [],
  series: [],
  range: '30d',
  startDate: null,
  endDate: null,
  previous: false,
  formula: undefined,
  unit: undefined,
  metric: 'sum',
  limit: 500,
  options: undefined,
  visibleSeries: undefined,
  metricQueries: [],
  stashedMetricQuery: undefined,
  stashedMetricQueries: undefined,
};

export const reportSlice = createSlice({
  name: 'report',
  initialState,
  reducers: {
    resetDirty(state) {
      return {
        ...state,
        dirty: false,
      };
    },
    reset() {
      return initialState;
    },
    ready() {
      return {
        ...initialState,
        ready: true,
      };
    },
    setReport(state, action: PayloadAction<IReport>) {
      return {
        ...state,
        ...action.payload,
        globalFilters: action.payload.globalFilters ?? [],
        metricQueries: action.payload.metricQueries ?? [],
        startDate: action.payload.startDate ?? null,
        endDate: action.payload.endDate ?? null,
        dirty: false,
        ready: true,
      };
    },
    setName(state, action: PayloadAction<string>) {
      state.dirty = true;
      state.name = action.payload;
    },
    // Series (Events and Formulas)
    addSerie: (
      state,
      action: PayloadAction<UnionOmit<IChartEventItem, 'id'>>,
    ) => {
      state.dirty = true;
      state.series.push({
        id: shortId(),
        ...action.payload,
      });
    },
    duplicateEvent: (state, action: PayloadAction<IChartEventItem>) => {
      state.dirty = true;
      if (action.payload.type === 'event') {
        state.series.push({
          ...action.payload,
          filters: action.payload.filters.map((filter) => ({
            ...filter,
            id: shortId(),
          })),
          id: shortId(),
        } as IChartEventItem);
      } else {
        state.series.push({
          ...action.payload,
          id: shortId(),
        } as IChartEventItem);
      }
    },
    removeEvent: (
      state,
      action: PayloadAction<{
        id?: string;
      }>,
    ) => {
      state.dirty = true;
      state.series = state.series.filter((event) => {
        return event.id !== action.payload.id;
      });
    },
    changeEvent: (state, action: PayloadAction<IChartEventItem>) => {
      state.dirty = true;
      state.series = state.series.map((event) => {
        if (event.id === action.payload.id) {
          return action.payload;
        }
        return event;
      });
    },

    // Previous
    changePrevious: (state, action: PayloadAction<boolean>) => {
      state.dirty = true;
      state.previous = action.payload;
    },

    // Breakdowns
    addBreakdown: (
      state,
      action: PayloadAction<Omit<IChartBreakdown, 'id'>>,
    ) => {
      state.dirty = true;
      state.breakdowns.push({
        id: shortId(),
        ...action.payload,
      });
    },
    removeBreakdown: (
      state,
      action: PayloadAction<{
        id?: string;
      }>,
    ) => {
      state.dirty = true;
      state.breakdowns = state.breakdowns.filter(
        (event) => event.id !== action.payload.id,
      );
    },
    changeBreakdown: (state, action: PayloadAction<IChartBreakdown>) => {
      state.dirty = true;
      state.breakdowns = state.breakdowns.map((breakdown) => {
        if (breakdown.id === action.payload.id) {
          return action.payload;
        }
        return breakdown;
      });
    },

    // Global filters (applied to every event series in the report)
    addGlobalFilter: (state, action: PayloadAction<IChartEventFilter>) => {
      state.dirty = true;
      state.globalFilters.push(action.payload);
    },
    removeGlobalFilter: (state, action: PayloadAction<{ id?: string }>) => {
      state.dirty = true;
      state.globalFilters = state.globalFilters.filter(
        (filter) => filter.id !== action.payload.id,
      );
    },
    changeGlobalFilter: (state, action: PayloadAction<IChartEventFilter>) => {
      state.dirty = true;
      state.globalFilters = state.globalFilters.map((filter) =>
        filter.id === action.payload.id ? action.payload : filter,
      );
    },

    // Interval
    changeInterval: (state, action: PayloadAction<IInterval>) => {
      state.dirty = true;
      state.interval = action.payload;
    },

    /**
     * Switch the report between analytics events and server telemetry.
     *
     * Both halves of the report are kept, but only one of them can legally be
     * on the wire at a time. An events report may carry a `series` the metrics
     * engine ignores — `report.update` writes it back untouched — so the event
     * side survives a round trip on its own. A `metricQuery` may not: the
     * superRefine on `report.create`/`report.update` rejects one whenever
     * `dataSource` is not `'metrics'`, so leaving it in place would turn every
     * save of an events report into a validation error the user cannot see the
     * cause of. It moves to `stashedMetricQuery` instead, which the tRPC input
     * schema strips, so flipping back restores the query the user built rather
     * than making them build it again.
     */
    changeDataSource: (state, action: PayloadAction<IReportDataSource>) => {
      // `dataSource` is optional and its absence means events, so compare the
      // normalized value — otherwise every untouched report reads as a change
      // and gets marked dirty by merely opening the menu.
      const current = state.dataSource ?? 'events';
      if (current === action.payload) {
        return;
      }

      state.dirty = true;
      state.dataSource = action.payload;

      if (action.payload === 'metrics') {
        // Left undefined until a metric is picked, rather than seeded with an
        // empty-string metric: undefined fails as "A metrics report needs a
        // metricQuery", which says what to do, where a blank stub fails deep
        // inside zMetricQuery on `metric` being too short.
        state.metricQuery = state.stashedMetricQuery;
        state.stashedMetricQuery = undefined;

        // The panel queries come back if there were any, and otherwise the
        // panel starts with one empty builder row. An empty LIST would render
        // a metrics panel with no editor at all and no obvious way to add one,
        // where a row with no metric picked reads as the thing to fill in.
        state.metricQueries = state.stashedMetricQueries ?? [];
        state.stashedMetricQueries = undefined;

        if (state.metricQueries.length === 0 && !state.metricQuery) {
          state.metricQueries = [createPanelQuery('A')];
        }

        // A metric report has to come back to a chart the metrics engine can
        // serve; the picker never offers the rest, but a report switched over
        // from events can be sitting on any of them.
        if (!isMetricChartType(state.chartType)) {
          state.chartType = 'linear';
        }
      } else {
        state.stashedMetricQuery = state.metricQuery;
        state.metricQuery = undefined;
        state.stashedMetricQueries = state.metricQueries;
        state.metricQueries = [];
      }
    },

    /**
     * Replace every query in the panel at once.
     *
     * The bulk form exists for the surfaces that own the list themselves — the
     * explorer restoring one from the URL, "Add to dashboard" carrying one
     * over. The editor uses the four granular actions below, because replacing
     * the whole list on every keystroke would make each row's identity depend
     * on its position and re-key the editors mid-word.
     */
    setMetricQueries(state, action: PayloadAction<IPanelQuery[]>) {
      state.dirty = true;
      state.dataSource = 'metrics';
      state.metricQueries = action.payload;
    },

    addMetricQuery(state, action: PayloadAction<IPanelQuery | undefined>) {
      state.dirty = true;
      state.dataSource = 'metrics';
      state.metricQueries.push(
        action.payload ?? createPanelQuery(nextRefId(state.metricQueries)),
      );
    },

    updateMetricQuery(
      state,
      action: PayloadAction<{ refId: string; query: IPanelQuery }>,
    ) {
      const index = state.metricQueries.findIndex(
        (query) => query.refId === action.payload.refId,
      );

      if (index === -1) {
        return;
      }

      // Read the outgoing metric BEFORE overwriting, or the comparison below is
      // against the value that was just assigned and never matches.
      const previousMetric = state.metricQueries[index]?.builder?.metric;
      const nextMetric = action.payload.query.builder?.metric;

      state.dirty = true;
      state.metricQueries[index] = action.payload.query;

      // The report name follows the FIRST query's metric until someone renames
      // it, which is what the explorer saves. A name the user chose is left
      // alone, and so is a name that came from another query in the panel.
      if (
        index === 0 &&
        nextMetric &&
        (!state.name || state.name === previousMetric)
      ) {
        state.name = nextMetric;
      }
    },

    removeMetricQuery(state, action: PayloadAction<string>) {
      state.dirty = true;
      state.metricQueries = state.metricQueries.filter(
        (query) => query.refId !== action.payload,
      );
    },

    duplicateMetricQuery(state, action: PayloadAction<string>) {
      const source = state.metricQueries.find(
        (query) => query.refId === action.payload,
      );

      if (!source) {
        return;
      }

      state.dirty = true;
      state.metricQueries.push({
        ...source,
        // A deep copy of the builder state: the two rows are edited
        // independently from here, and a shared `operations` array would make
        // every chip change on one show up on the other.
        builder: source.builder
          ? {
              ...source.builder,
              labelMatchers: source.builder.labelMatchers.map((matcher) => ({
                ...matcher,
              })),
              operations: source.builder.operations.map((op) => ({ ...op })),
            }
          : undefined,
        refId: nextRefId(state.metricQueries),
      });
    },

    /**
     * Replace the metric query of a metric report.
     *
     * The whole query at once rather than a field at a time: changing the
     * metric also resets the function and the group-by, and splitting that
     * across three actions would let a caller apply half of it and leave a
     * group-by that selects nothing on the new metric.
     */
    changeMetricQuery: (state, action: PayloadAction<IMetricQuery>) => {
      // Read the outgoing metric BEFORE overwriting the query, or the
      // comparison below is against the value that was just assigned and never
      // matches.
      const previousMetric = state.metricQuery?.metric;

      state.dirty = true;
      state.dataSource = 'metrics';
      state.metricQuery = action.payload;

      // The name follows the metric until someone renames it, which is what the
      // explorer saves. A name the user chose is left alone.
      if (!state.name || state.name === previousMetric) {
        state.name = action.payload.metric;
      }
    },

    // Chart type
    changeChartType: (state, action: PayloadAction<IChartType>) => {
      state.dirty = true;
      state.chartType = action.payload;

      // The Metric card has always shown the total unique count. Existing
      // reports are backfilled to 'count' by migration, so default a newly
      // switched one the same way rather than leaving old and new metric
      // reports showing different aggregations. The picker overrides it.
      if (action.payload === 'metric') {
        state.metric = 'count';
      }

      // Initialize sankey options if switching to sankey
      if (action.payload === 'sankey' && !state.options) {
        state.options = {
          type: 'sankey',
          mode: 'after',
          steps: 5,
          exclude: [],
        };
      }

      if (
        !isMinuteIntervalEnabledByRange(state.range) &&
        state.interval === 'minute'
      ) {
        state.interval = 'hour';
      }

      if (
        !isHourIntervalEnabledByRange(state.range) &&
        state.interval === 'hour'
      ) {
        state.interval = 'day';
      }
    },

    // Line type
    changeLineType: (state, action: PayloadAction<IChartLineType>) => {
      state.dirty = true;
      state.lineType = action.payload;
    },

    // Date range
    changeStartDate: (state, action: PayloadAction<string>) => {
      state.dirty = true;
      state.startDate = action.payload;

      const interval = getDefaultIntervalByDates(
        state.startDate,
        state.endDate,
      );
      if (interval) {
        state.interval = interval;
      }
    },

    // Date range
    changeEndDate: (state, action: PayloadAction<string>) => {
      state.dirty = true;
      state.endDate = action.payload;

      const interval = getDefaultIntervalByDates(
        state.startDate,
        state.endDate,
      );
      if (interval) {
        state.interval = interval;
      }
    },

    changeDateRanges: (state, action: PayloadAction<IChartRange>) => {
      state.dirty = true;
      state.range = action.payload;
      if (action.payload !== 'custom') {
        state.startDate = null;
        state.endDate = null;
        state.interval = getDefaultIntervalByRange(action.payload);
      }
    },

    // Formula
    changeFormula: (state, action: PayloadAction<string>) => {
      state.dirty = true;
      state.formula = action.payload;
    },

    changeCriteria(state, action: PayloadAction<z.infer<typeof zCriteria>>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'retention') {
        state.options = {
          type: 'retention',
          criteria: action.payload,
        };
      } else {
        state.options.criteria = action.payload;
      }
    },

    changeUnit(state, action: PayloadAction<string | undefined>) {
      state.dirty = true;
      state.unit = action.payload || undefined;
    },

    changeMetric(state, action: PayloadAction<IChartMetric>) {
      state.dirty = true;
      state.metric = action.payload;
    },

    changeFunnelGroup(state, action: PayloadAction<string | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          type: 'funnel',
          funnelGroup: action.payload,
          funnelWindow: undefined,
        };
      } else {
        state.options.funnelGroup = action.payload;
      }
    },

    changeFunnelWindow(state, action: PayloadAction<number | undefined>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'funnel') {
        state.options = {
          type: 'funnel',
          funnelGroup: undefined,
          funnelWindow: action.payload,
        };
      } else {
        state.options.funnelWindow = action.payload;
      }
    },
    changeOptions(state, action: PayloadAction<IReportOptions | undefined>) {
      state.dirty = true;
      state.options = action.payload || undefined;
    },
    changeSankeyMode(
      state,
      action: PayloadAction<'between' | 'after' | 'before'>,
    ) {
      state.dirty = true;
      if (!state.options) {
        state.options = {
          type: 'sankey',
          mode: action.payload,
          steps: 5,
          exclude: [],
        };
      } else if (state.options.type === 'sankey') {
        state.options.mode = action.payload;
      }
    },
    changeSankeySteps(state, action: PayloadAction<number>) {
      state.dirty = true;
      if (!state.options) {
        state.options = {
          type: 'sankey',
          mode: 'after',
          steps: action.payload,
          exclude: [],
        };
      } else if (state.options.type === 'sankey') {
        state.options.steps = action.payload;
      }
    },
    changeSankeyExclude(state, action: PayloadAction<string[]>) {
      state.dirty = true;
      if (!state.options) {
        state.options = {
          type: 'sankey',
          mode: 'after',
          steps: 5,
          exclude: action.payload,
        };
      } else if (state.options.type === 'sankey') {
        state.options.exclude = action.payload;
      }
    },
    changeSankeyInclude(state, action: PayloadAction<string[] | undefined>) {
      state.dirty = true;
      if (!state.options) {
        state.options = {
          type: 'sankey',
          mode: 'after',
          steps: 5,
          exclude: [],
          include: action.payload,
        };
      } else if (state.options.type === 'sankey') {
        state.options.include = action.payload;
      }
    },
    changeStacked(state, action: PayloadAction<boolean>) {
      state.dirty = true;
      if (!state.options || state.options.type !== 'histogram') {
        state.options = {
          type: 'histogram',
          stacked: action.payload,
        };
      } else {
        state.options.stacked = action.payload;
      }
    },
    reorderEvents(
      state,
      action: PayloadAction<{ fromIndex: number; toIndex: number }>,
    ) {
      state.dirty = true;
      const { fromIndex, toIndex } = action.payload;
      const [movedEvent] = state.series.splice(fromIndex, 1);
      if (movedEvent) {
        state.series.splice(toIndex, 0, movedEvent);
      }
    },
    changeVisibleSeries(
      state,
      action: PayloadAction<string[] | undefined>,
    ) {
      state.dirty = true;
      state.visibleSeries = action.payload;
    },
  },
});

// Action creators are generated for each case reducer function
export const {
  reset,
  ready,
  setReport,
  setName,
  addSerie,
  removeEvent,
  duplicateEvent,
  changeEvent,
  addBreakdown,
  removeBreakdown,
  changeBreakdown,
  addGlobalFilter,
  removeGlobalFilter,
  changeGlobalFilter,
  changeInterval,
  changeStartDate,
  changeEndDate,
  changeDateRanges,
  changeChartType,
  changeDataSource,
  changeMetricQuery,
  setMetricQueries,
  addMetricQuery,
  updateMetricQuery,
  removeMetricQuery,
  duplicateMetricQuery,
  changeLineType,
  resetDirty,
  changeFormula,
  changePrevious,
  changeCriteria,
  changeUnit,
  changeMetric,
  changeFunnelGroup,
  changeFunnelWindow,
  changeOptions,
  changeSankeyMode,
  changeSankeySteps,
  changeSankeyExclude,
  changeSankeyInclude,
  changeStacked,
  reorderEvents,
  changeVisibleSeries,
} = reportSlice.actions;

export default reportSlice.reducer;
