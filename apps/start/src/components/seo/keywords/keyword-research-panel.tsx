import { SearchIcon } from 'lucide-react';
import { KEYWORD_SOURCES, type KeywordSource } from './types';
import { WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SOURCE_HELP: Record<KeywordSource, string> = {
  ideas: 'Keywords that share words with your seed, sorted by volume.',
  suggestions: 'Long-tail phrases that contain your seed.',
  related: 'What people also search for after your seed.',
  ranked: 'Every keyword a domain already ranks for in the top 100.',
  gsc: 'Your top Search Console queries for the selected range, with volume and difficulty.',
};

interface Props {
  seed: string;
  onSeedChange: (value: string) => void;
  source: KeywordSource;
  onSourceChange: (value: KeywordSource) => void;
  /** Own domain first, then competitors. Only used by the ranked source. */
  domains: string[];
  domain: string;
  onDomainChange: (value: string) => void;
  gscConnected: boolean;
  onSubmit: () => void;
  isLoading: boolean;
}

export function KeywordResearchPanel({
  seed,
  onSeedChange,
  source,
  onSourceChange,
  domains,
  domain,
  onDomainChange,
  gscConnected,
  onSubmit,
  isLoading,
}: Props) {
  const definition = KEYWORD_SOURCES.find((entry) => entry.id === source);
  const needsSeed = definition?.needsSeed ?? true;
  const canSubmit = !isLoading && (!needsSeed || seed.trim().length > 0);

  return (
    <form
      className="card space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          onSubmit();
        }
      }}
    >
      <WithLabel label="Source">
        <Select
          onValueChange={(value) => onSourceChange(value as KeywordSource)}
          value={source}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KEYWORD_SOURCES.map((entry) => (
              <SelectItem
                disabled={entry.id === 'gsc' && !gscConnected}
                key={entry.id}
                value={entry.id}
              >
                {entry.label}
                {entry.id === 'gsc' && !gscConnected ? ' (connect GSC)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-2 text-muted-foreground text-xs">
          {SOURCE_HELP[source]}
        </p>
      </WithLabel>

      {needsSeed && (
        <WithLabel label="Seed keyword">
          <Input
            id="Seed keyword"
            onChange={(event) => onSeedChange(event.target.value)}
            placeholder="e.g. running shoes"
            value={seed}
          />
        </WithLabel>
      )}

      {source === 'ranked' && (
        <WithLabel
          info="Your tracked domain or one of the competitors from Settings → DataForSEO."
          label="Domain"
        >
          <Select onValueChange={onDomainChange} value={domain}>
            <SelectTrigger>
              <SelectValue placeholder="Domain" />
            </SelectTrigger>
            <SelectContent>
              {domains.map((entry, index) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                  {index === 0 ? ' (you)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </WithLabel>
      )}

      {source === 'gsc' && (
        <p className="text-muted-foreground text-xs">
          Uses the date range from the page header. Metrics missing from the
          cache are fetched in the background and appear on the next refresh.
        </p>
      )}

      <Button className="w-full" disabled={!canSubmit} type="submit">
        <SearchIcon className="mr-2 h-4 w-4" />
        {source === 'gsc' ? 'Load queries' : 'Research'}
      </Button>
    </form>
  );
}
