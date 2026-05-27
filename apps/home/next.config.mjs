/** @type {import('next').NextConfig} */
const DEMO_A2A_URL = process.env.DEMO_A2A_URL || 'https://demo-a2a-production.richardpedersen3.workers.dev';

const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are symlinked from the monorepo; transpile them so Next
  // bundles their (ESM) source/dist consistently across server + client.
  transpilePackages: [
    '@agenticprimitives/types',
    '@agenticprimitives/connect',
    '@agenticprimitives/connect-auth',
    '@agenticprimitives/agent-account',
    '@agenticprimitives/agent-naming',
    '@agenticprimitives/agent-profile',
    '@agenticprimitives/agent-relationships',
    '@agenticprimitives/delegation',
    '@agenticprimitives/identity-directory',
    '@agenticprimitives/identity-directory-adapters',
  ],
  // V1 parity with the Vite dev proxy + the Pages `/a2a/*` proxy: forward the
  // relayer calls to demo-a2a (strip the `/a2a` prefix). V2 replaces this with a
  // real Route Handler (`app/a2a/[...path]/route.ts`).
  async rewrites() {
    return [{ source: '/a2a/:path*', destination: `${DEMO_A2A_URL}/:path*` }];
  },
};

export default nextConfig;
