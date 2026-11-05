import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

process.env.NEXT_PUBLIC_CHAIN_ID ??= '34348';
const { CONTRACTS } = await import('../../apps/home/src/lib/chain');
const here = import.meta.dirname;
const jwk = readFileSync(join(here, 'artifacts/broker.jwk'), 'utf8').trim();

// The Home's real production build, in a real browser, with a local KV and a scriptable chain (fake-backends.mjs). It
// exercises what a preview or the live Home cannot: the flags on, wires revoked at will, and no gas or model spend.
// Build first: tests/e2e-local/build.sh. What it cannot reach: real wallets, real chain, and https-only cookie attributes.
export default defineConfig({
  testDir: here,
  timeout: 90_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5373', trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'] },
  outputDir: 'artifacts/results',
  webServer: [
    { command: 'node fake-backends.mjs', cwd: here, port: 8799, env: { PORT: '8799', FAKE_FACTORY: CONTRACTS.agentAccountFactory as string }, reuseExistingServer: false },
    {
      command: 'pnpm exec next start -p 5373',
      cwd: join(here, '../../apps/home'),
      url: 'http://localhost:5373/jwks',
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: {
        KV_REST_API_URL: 'http://127.0.0.1:8799/kv', KV_REST_API_TOKEN: 'test',
        RPC_URL: 'http://127.0.0.1:8799/rpc',
        BROKER_PRIVATE_JWK: jwk,
        ALLOWED_ISSUER_HOSTS: 'localhost',
        GOOGLE_CLIENT_ID: 'fake', GOOGLE_CLIENT_SECRET: 'fake', GOOGLE_REDIRECT_URI: 'http://localhost:5373/oidc/google/callback',
      },
    },
  ],
});
