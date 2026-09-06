import type { RouterOutputs } from '@/trpc/client';

export type AiAggregate = RouterOutputs['seo']['ai']['aggregate'];
export type AiShareOfVoice = RouterOutputs['seo']['ai']['shareOfVoice'];
export type AiTopPages = RouterOutputs['seo']['ai']['topPages'];
export type AiMentions = RouterOutputs['seo']['ai']['mentions'];
export type AiTraffic = RouterOutputs['seo']['ai']['traffic'];
export type AiEngine = AiAggregate['engines'][number]['engine'];

export const AI_ENGINE_OPTIONS: { value: AiEngine; label: string }[] = [
  { value: 'chat_gpt', label: 'ChatGPT' },
  { value: 'google', label: 'Google AI' },
];

/** Previous → current change as a percentage, null when there is no base. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}
