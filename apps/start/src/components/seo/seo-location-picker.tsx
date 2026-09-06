import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useDebounceValue } from '@/hooks/use-debounce-value';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';

interface Props {
  value: number | null;
  onChange: (locationCode: number) => void;
  className?: string;
  disabled?: boolean;
  error?: string;
}

/**
 * Searches the static DataForSEO location list through
 * `seo.settings.listLocations`. The list has tens of thousands of entries,
 * so the search runs server-side instead of shipping it to the client.
 */
export function SeoLocationPicker({
  value,
  onChange,
  className,
  disabled,
  error,
}: Props) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounceValue(search, 200);

  const resultsQuery = useQuery(
    trpc.seo.settings.listLocations.queryOptions(
      { q: debouncedSearch },
      { placeholderData: (previous) => previous }
    )
  );

  const selectedQuery = useQuery(
    trpc.seo.settings.listLocations.queryOptions(
      { locationCode: value ?? 0 },
      { enabled: value !== null }
    )
  );

  const selected = selectedQuery.data?.[0];
  const items = resultsQuery.data ?? [];

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className={cn(
            'justify-between',
            !!error && 'border-destructive',
            className
          )}
          disabled={disabled}
          role="combobox"
          variant="outline"
        >
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
            {value === null
              ? 'Select a location'
              : (selected?.name ?? `Location ${value}`)}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent align="start" className="w-full max-w-md p-0">
          <Command shouldFilter={false}>
            <CommandInput
              onValueChange={setSearch}
              placeholder="Search countries, regions, cities..."
              value={search}
            />
            <CommandList className="max-h-72">
              {items.length === 0 && (
                <CommandEmpty>
                  {resultsQuery.isLoading ? 'Loading...' : 'No locations found'}
                </CommandEmpty>
              )}
              {items.map((item) => (
                <CommandItem
                  key={item.code}
                  onSelect={() => {
                    onChange(item.code);
                    setOpen(false);
                  }}
                  value={String(item.code)}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4 shrink-0',
                      value === item.code ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="truncate">{item.name}</span>
                  <span className="ml-auto pl-2 text-muted-foreground text-xs uppercase">
                    {item.countryIsoCode}
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
