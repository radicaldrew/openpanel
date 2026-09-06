import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2Icon, SaveIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SeoLocationPicker } from './seo-location-picker';
import {
  domainFromSiteUrl,
  type SeoProjectConfig,
  useInvalidateSeoStatus,
} from './use-seo-status';
import { WithLabel } from '@/components/forms/input-with-label';
import TagInput from '@/components/forms/tag-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';

const DEFAULT_LOCATION_CODE = 2840; // United States
const DEFAULT_LANGUAGE_CODE = 'en';
const DEFAULT_SERP_DEPTH = 20;
const MIN_SERP_DEPTH = 10;
const MAX_SERP_DEPTH = 100;

/** Shown until `seo.settings.listLanguages` (the full SERP list) resolves. */
const FALLBACK_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'he', label: 'Hebrew' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'pl', label: 'Polish' },
  { code: 'cs', label: 'Czech' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'id', label: 'Indonesian' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' },
] as const;

const DEVICES = [
  { value: 'both', label: 'Desktop and mobile' },
  { value: 'desktop', label: 'Desktop only' },
  { value: 'mobile', label: 'Mobile only' },
] as const;

const SCHEDULES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'manual', label: 'Manual only' },
] as const;

type Devices = (typeof DEVICES)[number]['value'];
type Schedule = (typeof SCHEDULES)[number]['value'];

interface FormState {
  domain: string;
  locationCode: number | null;
  languageCode: string;
  devices: Devices;
  serpDepth: number;
  rankSchedule: Schedule;
  backlinkSchedule: Schedule;
  competitors: string[];
}

interface Props {
  projectId: string;
  config: SeoProjectConfig | null;
  /** Used to prefill the domain when there is no config yet. */
  gscSiteUrl?: string | null;
  /** `compact` shows only domain, location and language (the gate form). */
  variant?: 'compact' | 'full';
  disabled?: boolean;
  onSaved?: () => void;
  className?: string;
}

function initialState(
  config: SeoProjectConfig | null,
  gscSiteUrl: string | null | undefined
): FormState {
  return {
    domain: config?.domain ?? domainFromSiteUrl(gscSiteUrl),
    locationCode: config?.locationCode ?? DEFAULT_LOCATION_CODE,
    languageCode: config?.languageCode ?? DEFAULT_LANGUAGE_CODE,
    devices: config?.devices ?? 'both',
    serpDepth: config?.serpDepth ?? DEFAULT_SERP_DEPTH,
    rankSchedule: config?.rankSchedule ?? 'daily',
    backlinkSchedule: config?.backlinkSchedule ?? 'weekly',
    competitors: config?.competitors ?? [],
  };
}

const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function normalizeDomain(input: string): string {
  return domainFromSiteUrl(input.trim().toLowerCase());
}

export function SeoProjectConfigForm({
  projectId,
  config,
  gscSiteUrl,
  variant = 'full',
  disabled,
  onSaved,
  className,
}: Props) {
  const trpc = useTRPC();
  const invalidateStatus = useInvalidateSeoStatus();
  const languagesQuery = useQuery(
    trpc.seo.settings.listLanguages.queryOptions(undefined, {
      staleTime: Number.POSITIVE_INFINITY,
    })
  );
  const languages: ReadonlyArray<{ code: string; label: string }> =
    languagesQuery.data ?? FALLBACK_LANGUAGES;
  const [state, setState] = useState<FormState>(() =>
    initialState(config, gscSiteUrl)
  );
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>(
    {}
  );

  const mutation = useMutation(
    trpc.seo.settings.upsertProjectConfig.mutationOptions({
      onError: handleError,
      onSuccess: () => {
        toast.success('SEO settings saved');
        invalidateStatus();
        onSaved?.();
      },
    })
  );

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const domain = normalizeDomain(state.domain);
    const nextErrors: typeof errors = {};
    if (!DOMAIN_PATTERN.test(domain)) {
      nextErrors.domain = 'Enter a domain like example.com';
    }
    if (state.locationCode === null) {
      nextErrors.locationCode = 'Pick a location';
    }
    if (
      !Number.isInteger(state.serpDepth) ||
      state.serpDepth < MIN_SERP_DEPTH ||
      state.serpDepth > MAX_SERP_DEPTH
    ) {
      nextErrors.serpDepth = `Between ${MIN_SERP_DEPTH} and ${MAX_SERP_DEPTH}`;
    }
    const competitors = state.competitors
      .map(normalizeDomain)
      .filter((value) => value && value !== domain);
    if (competitors.some((value) => !DOMAIN_PATTERN.test(value))) {
      nextErrors.competitors = 'Competitors must be domains like example.com';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    mutation.mutate({
      projectId,
      domain,
      locationCode: state.locationCode ?? DEFAULT_LOCATION_CODE,
      languageCode: state.languageCode,
      devices: state.devices,
      serpDepth: state.serpDepth,
      rankSchedule: state.rankSchedule,
      backlinkSchedule: state.backlinkSchedule,
      competitors: Array.from(new Set(competitors)),
    });
  };

  const isFull = variant === 'full';
  const isBusy = disabled || mutation.isPending;

  return (
    <form className={cn('space-y-4', className)} onSubmit={submit}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <WithLabel
          error={errors.domain}
          info="The site you want to track, without protocol or path."
          label="Domain"
        >
          <Input
            disabled={isBusy}
            error={errors.domain}
            id="Domain"
            onChange={(e) => update('domain', e.target.value)}
            placeholder="example.com"
            value={state.domain}
          />
        </WithLabel>
        <WithLabel
          error={errors.locationCode}
          info="Where searches are simulated from. Affects rankings and volumes."
          label="Location"
        >
          <SeoLocationPicker
            className="w-full"
            disabled={isBusy}
            error={errors.locationCode}
            onChange={(code) => update('locationCode', code)}
            value={state.locationCode}
          />
        </WithLabel>
        <WithLabel label="Language">
          <Select
            disabled={isBusy}
            onValueChange={(value) => update('languageCode', value)}
            value={state.languageCode}
          >
            <SelectTrigger>
              <SelectValue placeholder="Language" />
            </SelectTrigger>
            <SelectContent>
              {languages.map((language) => (
                <SelectItem key={language.code} value={language.code}>
                  {language.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </WithLabel>
      </div>

      {isFull && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <WithLabel
              info="Which devices rank checks run on. Both doubles the cost per keyword."
              label="Devices"
            >
              <Select
                disabled={isBusy}
                onValueChange={(value) => update('devices', value as Devices)}
                value={state.devices}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEVICES.map((device) => (
                    <SelectItem key={device.value} value={device.value}>
                      {device.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WithLabel>
            <WithLabel
              error={errors.serpDepth}
              info={`How many results to fetch per keyword (${MIN_SERP_DEPTH}-${MAX_SERP_DEPTH}). Deeper is more expensive.`}
              label="SERP depth"
            >
              <Input
                disabled={isBusy}
                error={errors.serpDepth}
                id="SERP depth"
                max={MAX_SERP_DEPTH}
                min={MIN_SERP_DEPTH}
                onChange={(e) => update('serpDepth', Number(e.target.value))}
                step={10}
                type="number"
                value={state.serpDepth}
              />
            </WithLabel>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <WithLabel
              info="How often tracked keywords are re-checked."
              label="Rank schedule"
            >
              <Select
                disabled={isBusy}
                onValueChange={(value) =>
                  update('rankSchedule', value as Schedule)
                }
                value={state.rankSchedule}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULES.map((schedule) => (
                    <SelectItem key={schedule.value} value={schedule.value}>
                      {schedule.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WithLabel>
            <WithLabel
              info="How often the backlink profile is refreshed."
              label="Backlink schedule"
            >
              <Select
                disabled={isBusy}
                onValueChange={(value) =>
                  update('backlinkSchedule', value as Schedule)
                }
                value={state.backlinkSchedule}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULES.map((schedule) => (
                    <SelectItem key={schedule.value} value={schedule.value}>
                      {schedule.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WithLabel>
          </div>

          <WithLabel
            error={errors.competitors}
            info="Domains to compare share of voice and backlinks against. Press Enter after each."
            label="Competitors"
          >
            <TagInput
              error={errors.competitors}
              id="Competitors"
              onChange={(value) => update('competitors', value)}
              placeholder="competitor.com"
              value={state.competitors}
            />
          </WithLabel>
        </>
      )}

      <Button disabled={isBusy} type="submit">
        {mutation.isPending ? (
          <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <SaveIcon className="mr-2 h-4 w-4" />
        )}
        {config ? 'Save' : 'Start tracking'}
      </Button>
    </form>
  );
}
