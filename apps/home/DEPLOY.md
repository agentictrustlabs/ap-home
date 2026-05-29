# demo-sso-next — Vercel deploy runbook (spec 232, V3 + V4)

The Next app is built + verified locally. These steps need YOUR Vercel account
(I have Cloudflare/`wrangler` auth, not Vercel). Everything here is a one-time
setup; after it, `vercel --prod` redeploys.

## V3 — Vercel project + KV + secrets + preview

1. **Install + login**
   ```bash
   npm i -g vercel        # or: pnpm dlx vercel
   vercel login
   ```

   

2. **Link the project** (run from `apps/demo-sso-next`)
   ```bash
   cd apps/demo-sso-next && vercel link
   ```
   In the Vercel dashboard → Project → **Settings → General → Root Directory =
   `apps/demo-sso-next`**. (`vercel.json` here already sets the monorepo install +
   build commands — it builds `packages/*` first because their `dist/` is
   gitignored, then `next build`.)

3. **Attach Vercel KV** (the `AUTH_CODES` store)
   Dashboard → **Storage → Create → KV** (Upstash) → **Connect** to this project.
   This auto-injects `KV_REST_API_URL` + `KV_REST_API_TOKEN`.

4. **Broker key + env vars** (see `.env.example` for the full list)
   ```bash
   node ../demo-sso/scripts/gen-broker-key.mjs     # → BROKER_PRIVATE_JWK + kid
   vercel env add BROKER_PRIVATE_JWK production     # paste the JWK (mark Sensitive)
   vercel env add BROKER_KID production             # e.g. broker-1
   vercel env add RPC_URL production                # Base Sepolia (keyed RPC; Sensitive)
   vercel env add REDIRECT_URI_ALLOWLIST production  # demo-org redirect URIs
   vercel env add DEMO_A2A_URL production           # the Cloudflare demo-a2a relayer URL
   # optional Google OIDC:
   vercel env add GOOGLE_CLIENT_ID production
   vercel env add GOOGLE_CLIENT_SECRET production    # Sensitive
   vercel env add GOOGLE_REDIRECT_URI production      # https://impact-agent.me/oidc/google/callback
   ```

5. **Deploy a preview + verify**
   ```bash
   vercel            # preview deploy → https://<deploy>.vercel.app
   ```
   On the preview URL:
   - `GET /.well-known/openid-configuration` → `issuer` = the preview host (200).
   - `GET /jwks` → 200 (proves `BROKER_PRIVATE_JWK` + KV wiring).
   - Open `/` → the SPA renders; passkey/SIWE/Google sign-in + `/me` work
     (KV-backed codes/nonces).
   - `/a2a/*` relayer calls reach demo-a2a (the `next.config` rewrite).
   - Generic A2A card: `GET /.well-known/agent-card.json` (preview host has no
     `<handle>` subdomain → generic card; agent-bound needs the wildcard, V4).

## V4 — Wildcard domain + cutover (SSO = `*.impact-agent.me`)

> **Split (spec 232):** SSO/human = `*.impact-agent.me` (this Vercel app);
> A2A/machine = `*.impact-agent.io` (Cloudflare demo-a2a Worker, ALREADY LIVE).
> This step only sets up the `.me` SSO domain.

1. **Add the domains to the Vercel project** (Pro plan required for wildcard)
   Dashboard → Settings → **Domains** → add **`*.impact-agent.me`** AND
   **`impact-agent.me`** (apex). Vercel shows the DNS target (e.g.
   `cname.vercel-dns.com`).

2. **Point DNS at Vercel — DNS-only at Cloudflare** (free-plan-friendly: a
   **DNS-only / grey-cloud** record is allowed; only *proxied* wildcards need
   Enterprise. Vercel does the wildcard routing + TLS.)
   In Cloudflare DNS for **`impact-agent.me`**:
   - `CNAME  *  → cname.vercel-dns.com`  — **Proxy status: DNS only (grey)**
   - `CNAME  @ (apex)  → cname.vercel-dns.com` — **DNS only** (or the apex
     A/ALIAS record Vercel specifies)

3. **Google console** (if using Google OIDC): add
   `https://impact-agent.me/oidc/google/callback` as an Authorized redirect URI.
   (Google redirect URIs can't be wildcards — keep Google at the apex/bootstrap
   origin.)

4. **demo-org** (already redeployed): its `resolveAuthOrigin` derives
   `https://<label>.impact-agent.me`, and it discovers the OP via
   `/.well-known/openid-configuration` + `/jwks` (served by Vercel). demo-a2a
   already allows `https://*.impact-agent.me` (CORS) for the relayer calls.

5. **Retire** the old Cloudflare Pages `agenticprimitives-demo-sso` project (and
   its staged Option-2 edits in `apps/demo-sso` — superseded; delete with the app).
   The apex `impact-agent.io` Pages domain is now orphaned (A2A owns the `.io`
   wildcard) — repoint or drop it.

### Verify `alice.impact-agent.me` (SSO) end-to-end
- `GET https://alice.impact-agent.me/.well-known/openid-configuration` →
  `issuer: https://alice.impact-agent.me`.
- `GET https://alice.impact-agent.me/jwks` → 200 (broker key live).
- Browser: visit `alice.impact-agent.me` → passkey registers with
  `rpId=alice.impact-agent.me`; on demo-org, sign in as `alice` → the OIDC popup
  opens at `alice.impact-agent.me` and the `id_token` `iss` matches.

(A2A is separate + already live: `curl https://alice.impact-agent.io/.well-known/agent-card.json`.)
