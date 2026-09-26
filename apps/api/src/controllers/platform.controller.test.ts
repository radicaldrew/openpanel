import { describe, expect, it, vi } from 'vitest';

vi.mock('@openpanel/db', () => ({ db: {}, getId: vi.fn() }));
vi.mock('@openpanel/common/server', () => ({ hashPassword: vi.fn() }));

import { platformTokenMatches } from './platform.controller';

describe('platformTokenMatches', () => {
  const token = 'x'.repeat(40);
  it('accepts the configured token', () => {
    expect(platformTokenMatches(token, token)).toBe(true);
  });
  it('refuses anything else, including a prefix', () => {
    expect(platformTokenMatches('nope', token)).toBe(false);
    expect(platformTokenMatches(token.slice(0, 39), token)).toBe(false);
    expect(platformTokenMatches(undefined, token)).toBe(false);
  });
  it('fails closed when none, or a short one, is configured', () => {
    expect(platformTokenMatches('', undefined)).toBe(false);
    expect(platformTokenMatches('short', 'short')).toBe(false);
  });
});
