import { z } from 'zod';
import type { DataforseoTransport } from './core';
import { assertOk, buildFreeTaskBilling, type DataforseoApiResponse } from './envelope';
import { formatLocationLabel } from './locations';

export interface SerpLocationResult {
  locationCode: number;
  locationName: string;
  locationType: string;
  displayLabel: string;
}

// Sub-country granularities users actually target. Deliberately excludes
// Postal Code (~32k extra rows for the US alone), State (national-ish), and
// long-tail types like Airport / University.
export const SERP_LOCATION_TYPES = [
  'City',
  'County',
  'Municipality',
  'DMA Region',
  'Region',
] as const;

const INCLUDED_LOCATION_TYPES = new Set<string>(SERP_LOCATION_TYPES);

const locationItemSchema = z.object({
  location_code: z.number(),
  location_name: z.string(),
  location_type: z.string().nullable().optional(),
});

/**
 * Full sub-country location list for one country. `countryCode` is ISO
 * 3166-1 alpha-2 ("us", "gb") — the endpoint rejects country *names* with a
 * task-level Invalid Field error, which assertOk surfaces.
 *
 * The DataForSEO response is ~9.5MB for the US and the endpoint has no search
 * parameter, so callers should cache the slimmed list (Google refreshes
 * geotargets roughly quarterly; 30 days is plenty). The endpoint is free.
 */
export async function fetchSerpLocationsForCountry(
  transport: DataforseoTransport,
  countryCode: string,
): Promise<DataforseoApiResponse<SerpLocationResult[]>> {
  const iso = countryCode.toLowerCase();
  const path = `/v3/serp/google/locations/${encodeURIComponent(iso)}`;
  const response = await transport.get(path);
  const task = assertOk(response, { path });
  const data = (task.result ?? [])
    .map((item) => locationItemSchema.safeParse(item))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((item) => INCLUDED_LOCATION_TYPES.has(item.location_type ?? ''))
    .map((item) => ({
      locationCode: item.location_code,
      locationName: item.location_name,
      displayLabel: formatLocationLabel(item.location_name),
      locationType: item.location_type ?? '',
    }));
  return { data, billing: buildFreeTaskBilling(task, path) };
}
