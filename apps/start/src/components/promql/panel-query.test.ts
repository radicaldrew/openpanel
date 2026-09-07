/**
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/promql
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_PANEL_QUERIES,
  createPanelQuery,
  nextRefId,
} from './panel-query';

describe('nextRefId', () => {
  it('starts at A', () => {
    expect(nextRefId([])).toBe('A');
  });

  it('takes the next free letter', () => {
    expect(nextRefId([{ refId: 'A' }, { refId: 'B' }])).toBe('C');
  });

  it('reuses the letter of a deleted query rather than counting on', () => {
    // refIds show up in legends and in error messages ("Query B: …"), so a
    // panel that has had rows added and removed should read A, B, C.
    expect(nextRefId([{ refId: 'A' }, { refId: 'C' }])).toBe('B');
  });
});

describe('createPanelQuery', () => {
  it('spells out every field zPanelQuery defaults', () => {
    // The inferred type has these required, so a row built without them is not
    // an IPanelQuery at all — this is the one place that has to remember.
    expect(createPanelQuery('A')).toEqual({
      refId: 'A',
      expr: '',
      mode: 'builder',
      hidden: false,
      unit: 'none',
      yAxis: 'left',
      instant: false,
    });
  });

  it('takes overrides', () => {
    expect(createPanelQuery('B', { expr: 'up', mode: 'code' })).toMatchObject({
      refId: 'B',
      expr: 'up',
      mode: 'code',
    });
  });

  it('agrees with the schema cap', () => {
    expect(MAX_PANEL_QUERIES).toBe(10);
  });
});
