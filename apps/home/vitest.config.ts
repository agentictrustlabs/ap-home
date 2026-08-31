import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Next sets `jsx: preserve` in tsconfig (it does its own transform), which vitest inherits — so any test
  // reaching a module that imports a .tsx file died at "content contains invalid JS syntax" rather than at
  // an assertion. Transforming JSX here lets a pure module be tested even when it imports an icon set.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
