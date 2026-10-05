import { describe, expect, it } from 'vitest';
import { appWorkspacesFromEnv } from './app-workspaces';

// The listing's hrefs are where THIS Home sends a member to open Gather and where it reads the gate.
// They must come from the same variables the client registry already reads, or a second deployment's
// Home links to the wrong estate's Gather while its sign-in correctly targets its own.
describe('appWorkspacesFromEnv', () => {
  it('keeps today’s hrefs when nothing is set', () => {
    const [g] = appWorkspacesFromEnv({});
    expect(g.id).toBe('gather27');
    expect(g.appHref).toBe('https://gather27-web.richardpedersen3.workers.dev/');
    expect(g.listingHref).toBe('https://gather27-a2a-production.richardpedersen3.workers.dev');
  });

  it('takes the HOST surface — the first https origin — as the app link', () => {
    const [g] = appWorkspacesFromEnv({
      NEXT_PUBLIC_GATHER_ORIGINS: 'https://gather27.example.org/,https://ops-gather27.example.org/,https://find-gather27.example.org/',
      NEXT_PUBLIC_GATHER_A2A_BASE: 'https://a2a-gather27.example.org/',
    });
    expect(g.appHref).toBe('https://gather27.example.org/');
    // The gate base is used as `${listingHref}/a2a`, so a trailing slash is stripped.
    expect(g.listingHref).toBe('https://a2a-gather27.example.org');
  });

  it('skips a localhost origin listed first and still picks an https one', () => {
    const [g] = appWorkspacesFromEnv({
      NEXT_PUBLIC_GATHER_ORIGINS: 'http://localhost:5175/,https://gather27.example.org/',
    });
    expect(g.appHref).toBe('https://gather27.example.org/');
  });

  it('honours the singular variable when the plural is absent', () => {
    const [g] = appWorkspacesFromEnv({ NEXT_PUBLIC_GATHER_ORIGIN: 'https://gather27.example.org/' });
    expect(g.appHref).toBe('https://gather27.example.org/');
  });
});
