import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Next sets `jsx: preserve` in tsconfig (it does its own transform), which vitest inherits — so any test
  // reaching a module that imports a .tsx file died at "content contains invalid JS syntax" rather than at
  // an assertion. Transforming JSX here lets a pure module be tested even when it imports an icon set.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // `lib/chain.ts` REQUIRES a declared chain and throws without one — there is no default, because a
    // chain id is part of what a signature means (2026-10-14). The suite runs against the committed
    // faithchain deployment table, so it says so here rather than letting a default say it silently.
    env: { NEXT_PUBLIC_CHAIN_ID: '34348' },
  },
});
