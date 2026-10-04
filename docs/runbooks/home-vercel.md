# The Home on Vercel — project `faithnet-home` (`https://www.faithnet.me`)

Root directory `apps/home`, builds `master` of this repository. `apps/home/vercel.json` names the install and build
(`cd ../.. && npx -y pnpm@9.15.0 install --no-frozen-lockfile` / `… run build:home`) — the repository commits no root
lock, so the install resolves the pinned `@agenticprimitives/*` set fresh, exactly as CI does.

The project's ~60 environment variables (chain, contracts, brand, the runtime / vault / edge / home-mcp origins, the
broker key, the Upstash KV, `DEMO_PERSONA_KEYS`) live ON THE PROJECT and did not change when its Git source moved here
from Ring 0 (2026-10-04). Set them with the REST API (`POST /v10/projects/{id}/env?upsert=true`; the CLI's `vercel env
add` stores an empty value for a piped secret) and redeploy — `NEXT_PUBLIC_*` is inlined at build.

Smoke after a deploy: `curl https://www.faithnet.me/jwks` answers with the broker key; `/.well-known/agentic-home`
answers; a persona signs in and the Ask answers.
