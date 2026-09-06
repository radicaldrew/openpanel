/**
 * searchLocations backs the location picker; it must find a country by its
 * name, its short label and its ISO code, prefer prefix matches, respect the
 * limit, and never reach DataForSEO (the list is static).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@openpanel/db', () => ({
  getDfsConnection: vi.fn(),
  getSeoStatus: vi.fn(),
  refreshDfsBalance: vi.fn(),
  removeDfsConnection: vi.fn(),
  setDfsSpendCap: vi.fn(),
  upsertDfsConnection: vi.fn(),
  upsertSeoProjectConfig: vi.fn(),
  validateDfsCredentials: vi.fn(),
  DfsNotConfiguredError: class DfsNotConfiguredError extends Error {},
  SeoConfigMissingError: class SeoConfigMissingError extends Error {},
}));

const { searchLocations } = await import('./settings');

const UNITED_STATES = 2840;
const UNITED_KINGDOM = 2826;
const ISRAEL = 2376;

describe('searchLocations', () => {
  it('returns the first page of the static list when the query is empty', () => {
    const rows = searchLocations('', 10);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({
      code: expect.any(Number),
      name: expect.any(String),
      countryIsoCode: expect.any(String),
      languageCode: expect.any(String),
    });
  });

  it('matches by name, ISO code and short label', () => {
    expect(searchLocations('united states', 5)[0]?.code).toBe(UNITED_STATES);
    expect(searchLocations('us', 50).map((row) => row.code)).toContain(UNITED_STATES);
    expect(searchLocations('israel', 5)[0]?.code).toBe(ISRAEL);
    expect(searchLocations('il', 50).map((row) => row.code)).toContain(ISRAEL);
  });

  it('ranks prefix matches ahead of substring matches', () => {
    const rows = searchLocations('united', 50);
    const codes = rows.map((row) => row.code);
    expect(codes).toContain(UNITED_STATES);
    expect(codes).toContain(UNITED_KINGDOM);
    for (const row of rows.slice(0, 2)) {
      expect(row.name.toLowerCase().startsWith('united')).toBe(true);
    }
  });

  it('respects the limit and is case-insensitive', () => {
    expect(searchLocations('A', 3)).toHaveLength(3);
    expect(searchLocations('ISRAEL', 5)).toEqual(searchLocations('israel', 5));
  });

  it('returns nothing for a query no location matches', () => {
    expect(searchLocations('zzzz-not-a-place', 10)).toEqual([]);
  });
});
