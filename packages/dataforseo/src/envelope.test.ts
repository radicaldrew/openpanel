import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertOk, parseTaskItems, parseTaskTotalCount } from './envelope';
import { DataForSeoChargedTaskError, DataForSeoError } from './errors';

const itemSchema = z.object({ keyword: z.string().optional() }).passthrough();

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

describe('parseTaskItems', () => {
  it('returns [] when the result items are null', () => {
    const task = { status_code: 20_000, result: [{ items: null }] };
    expect(parseTaskItems('x', task, itemSchema)).toEqual([]);
  });

  it('returns [] when there is no result', () => {
    expect(parseTaskItems('x', { result: undefined }, itemSchema)).toEqual([]);
  });

  it('parses present items', () => {
    const task = { result: [{ items: [{ keyword: 'seo' }] }] };
    expect(parseTaskItems('x', task, itemSchema)).toEqual([{ keyword: 'seo' }]);
  });

  it('throws invalid_response with the first issues when the shape is off', () => {
    const task = { path: ['v3', 'x'], result: [{ items: [{ keyword: 42 }] }] };
    const error = catchError(() => parseTaskItems('x', task, itemSchema));
    expect(error).toBeInstanceOf(DataForSeoError);
    expect(error).toMatchObject({ kind: 'invalid_response', path: '/v3/x' });
    expect((error as Error).message).toContain('0.keyword');
  });

  it('reads total_count', () => {
    expect(parseTaskTotalCount({ result: [{ total_count: 12 }] })).toBe(12);
    expect(parseTaskTotalCount({ result: [{}] })).toBeNull();
    expect(parseTaskTotalCount({})).toBeNull();
  });
});

describe('assertOk', () => {
  const okTask = {
    status_code: 20_000,
    path: ['v3', 'backlinks', 'summary', 'live'],
    cost: 0.1,
    result_count: 1,
    result: [],
  };

  it('returns the first task on success', () => {
    expect(assertOk({ status_code: 20_000, tasks: [okTask] })).toBe(okTask);
  });

  it('accepts a custom ok status (task_post answers 20100)', () => {
    const task = { status_code: 20_100, id: 'abc', cost: 0.001, path: ['v3', 'on_page', 'task_post'] };
    expect(assertOk({ status_code: 20_000, tasks: [task] }, { okTaskStatusCode: 20_100 })).toBe(task);
  });

  it('throws invalid_response for an empty response or a missing task', () => {
    expect(catchError(() => assertOk(null, { path: '/v3/x' }))).toMatchObject({
      kind: 'invalid_response',
      path: '/v3/x',
    });
    expect(catchError(() => assertOk({ status_code: 20_000, tasks: [] }))).toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('throws DataForSeoChargedTaskError when a charged task fails', () => {
    const task = {
      status_code: 40_000,
      status_message: 'fail',
      path: ['v3', 'backlinks', 'summary', 'live'],
      cost: 0.05,
      result_count: 0,
    };
    const error = catchError(() => assertOk({ status_code: 20_000, tasks: [task] }));
    expect(error).toBeInstanceOf(DataForSeoChargedTaskError);
    expect(error).toMatchObject({
      kind: 'task',
      dfsStatusCode: 40_000,
      path: '/v3/backlinks/summary/live',
      billing: { path: task.path, costUsd: 0.05 },
      isInvalidField: false,
    });
  });

  it("classifies DataForSEO's own server errors as upstream (still charged)", () => {
    const task = {
      status_code: 40_101,
      status_message: 'Internal SE Server Error.',
      path: ['v3', 'serp', 'google', 'organic', 'live', 'advanced'],
      cost: 0.002,
      result_count: 0,
    };
    const error = catchError(() => assertOk({ status_code: 20_000, tasks: [task] }));
    expect(error).toBeInstanceOf(DataForSeoChargedTaskError);
    expect(error).toMatchObject({ kind: 'upstream', retryable: true });
  });

  it("keeps 'Not Implemented' a plain task failure — we posted a bad task", () => {
    const task = {
      status_code: 50_100,
      status_message: 'Not Implemented.',
      path: ['v3', 'serp', 'google', 'organic', 'live', 'advanced'],
      cost: 0.002,
      result_count: 0,
    };
    const error = catchError(() => assertOk({ status_code: 20_000, tasks: [task] }));
    expect(error).toBeInstanceOf(DataForSeoChargedTaskError);
    expect(error).toMatchObject({ kind: 'task', retryable: false });
  });

  it("appends the echoed request value to opaque 'Invalid Field' failures", () => {
    const task = {
      status_code: 40_501,
      status_message: "Invalid Field: 'target'.",
      path: ['v3', 'dataforseo_labs', 'google', 'domain_rank_overview', 'live'],
      cost: 0.02,
      result_count: 0,
      data: { target: 'not a valid domain', language_code: 'en' },
    };
    const error = catchError(() => assertOk({ status_code: 20_000, tasks: [task] }));
    expect(error).toBeInstanceOf(DataForSeoChargedTaskError);
    expect(error).toMatchObject({
      message: `Invalid Field: 'target'. (sent target="not a valid domain")`,
      isInvalidField: true,
    });
  });

  it('classifies a top-level balance failure as billing', () => {
    const error = catchError(() =>
      assertOk(
        { status_code: 40_200, status_message: 'balance is too low', tasks: [] },
        { path: '/v3/backlinks/summary/live' },
      ),
    );
    expect(error).not.toBeInstanceOf(DataForSeoChargedTaskError);
    expect(error).toMatchObject({
      kind: 'billing',
      dfsStatusCode: 40_200,
      path: '/v3/backlinks/summary/live',
      message: 'balance is too low',
    });
  });

  it('classifies a top-level 40100 as auth', () => {
    expect(
      catchError(() =>
        assertOk({ status_code: 40_100, status_message: 'Unauthorized.', tasks: [] }),
      ),
    ).toMatchObject({ kind: 'auth', dfsStatusCode: 40_100 });
  });

  it.each([40_200, 40_210, 402])(
    'classifies account failure %s as billing before charging billed task metadata',
    (status) => {
      const task = {
        status_code: status,
        status_message: 'Account balance is too low',
        path: ['v3', 'backlinks', 'summary', 'live'],
        cost: 0.05,
        result_count: 0,
      };
      const error = catchError(() => assertOk({ status_code: 20_000, tasks: [task] }));
      expect(error).not.toBeInstanceOf(DataForSeoChargedTaskError);
      expect(error).toMatchObject({ kind: 'billing', dfsStatusCode: status });
    },
  );

  it('treats a no-results task as an empty success when asked', () => {
    const task = {
      status_code: 40_501,
      status_message: 'No Search Results',
      path: ['v3', 'serp', 'google', 'organic', 'live', 'advanced'],
      cost: 0.0,
    };
    expect(
      assertOk({ status_code: 20_000, tasks: [task] }, { treatNoResultsAsEmpty: true }),
    ).toBe(task);
  });

  it("still surfaces a charged 40501 'Invalid Field' failure even with treatNoResultsAsEmpty", () => {
    // 40501 is not unique to no-results — it also covers validation rejections,
    // which are real charged failures we must not mask as empty results.
    const task = {
      status_code: 40_501,
      status_message: "Invalid Field: 'categories'.",
      path: ['v3', 'business_data', 'business_listings', 'search', 'live'],
      cost: 0.02,
      result_count: 0,
      data: { categories: ['not_a_real_category'] },
    };
    const error = catchError(() =>
      assertOk({ status_code: 20_000, tasks: [task] }, { treatNoResultsAsEmpty: true }),
    );
    expect(error).toBeInstanceOf(DataForSeoChargedTaskError);
    expect(error).toMatchObject({ billing: { path: task.path, costUsd: 0.02 } });
  });

  it('throws a plain task error when a failed task carries no billing metadata', () => {
    const task = { status_code: 40_000, status_message: 'Bad Request.' };
    const error = catchError(() =>
      assertOk({ status_code: 20_000, tasks: [task] }, { path: '/v3/x' }),
    );
    expect(error).toBeInstanceOf(DataForSeoError);
    expect(error).not.toBeInstanceOf(DataForSeoChargedTaskError);
    expect(error).toMatchObject({ kind: 'task', path: '/v3/x', dfsStatusCode: 40_000 });
  });
});
