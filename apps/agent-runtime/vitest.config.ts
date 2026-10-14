import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The workflow adapter imports Cloudflare's runtime modules, which only exist inside a Worker.
      // Tests exercise the ENGINE-FREE core (harness-workflow-core.test.ts, the four spec-362 gates);
      // the adapter itself just needs to be importable wherever index.ts is pulled in.
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
      'cloudflare:workflows': new URL('./test/stubs/cloudflare-workflows.ts', import.meta.url).pathname,
    },
  },
  test: {
    // One suite reaches the Home's `lib/chain.ts`, which REQUIRES a declared chain and throws without one:
    // there is no default, because a chain id is part of what a signature means (2026-10-14). The suite runs
    // against the committed faithchain table, so it says so rather than letting a default say it silently.
    env: { NEXT_PUBLIC_CHAIN_ID: '34348' },
  },
});
