# Google OIDC setup for demo-sso

Real Google sign-in for the Connect broker. The OAuth **client secret must be
server-side** — so the config lives on the **Pages Function broker**
(`functions/oidc/google/*`), NOT in the browser bundle. (This is the same reason
smart-agent keeps it in `apps/web/.env` / `google-oauth.ts`, never the client.)

## 1. Where the values go (demo-sso Pages env)

All values are read by `functions/_lib/server-broker.ts` →
`functions/oidc/google/{start,callback}.ts` via `context.env.*` (the demo-sso
analogue of smart-agent's `apps/web/src/lib/auth/google-oauth.ts` reading
`process.env.GOOGLE_*`). There are **two** setup paths — local and deploy.

### A. Local dev (start here) — `.dev.vars`, NO Cloudflare project needed

`wrangler pages secret put` targets a **deployed Pages project**, so it fails
with *"Project does not exist"* before you've created one. For local dev you do
NOT use it — put the values in a gitignored `.dev.vars` at the app root (copy
`.dev.vars.example`):

```bash
cp .dev.vars.example .dev.vars
node scripts/gen-broker-key.mjs   # paste BROKER_PRIVATE_JWK + BROKER_KID into .dev.vars
# fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI

pnpm --filter @agenticprimitives-demo/sso build
wrangler pages dev dist --kv AUTH_CODES    # :8788 — --kv gives a LOCAL KV (no remote namespace)
```

`--kv AUTH_CODES` provisions a local-only KV for the binding (the `wrangler.toml`
`id` is only used on deploy). `.dev.vars` is loaded automatically.

### B. Deploy — create the project FIRST, then secrets + a real KV

```bash
wrangler pages project create demo-sso              # or the first `wrangler pages deploy dist` creates it
wrangler kv namespace create AUTH_CODES             # paste the id into wrangler.toml
wrangler pages secret put GOOGLE_CLIENT_ID          # now the project exists → these work
wrangler pages secret put GOOGLE_CLIENT_SECRET      # (server-only!)
wrangler pages secret put GOOGLE_REDIRECT_URI       # the exact prod callback URL (below)
wrangler pages secret put BROKER_PRIVATE_JWK
wrangler pages secret put BROKER_KID
wrangler pages deploy dist
```

(`*_SECRET` / `BROKER_PRIVATE_JWK` MUST be secrets; the rest can be plain Pages
env vars, but secrets are fine.)

### Production specifics (the live demo site)

- **Your deployed Pages origin IS the Connect origin** (e.g.
  `https://demo-sso.pages.dev` or a custom domain). The token `iss` is **derived
  from the serving origin automatically** — there's nothing to set; server + the
  browser (same origin) agree by construction. (Local :5373 / :8788 just work too.)
- **`GOOGLE_REDIRECT_URI` = `https://<your-prod-origin>/oidc/google/callback`** —
  must match the Pages origin exactly, and be registered in the Google console.
- **KV is required in prod, not optional** — `/authorize` and `/token` (and the
  OIDC `state`) may run on different isolates, so the auth-code store MUST be a
  real KV namespace (uncomment `[[kv_namespaces]]` + paste the id). The in-memory
  store only works in single-isolate local dev.
- **Real (multi-origin) relying sites:** register each relying site's callback in
  `REDIRECT_URI_ALLOWLIST` (comma-separated, exact-match) — the broker refuses to
  deliver the code anywhere else (CN-1). In this demo the relying site is the
  demo page itself, so its own origin is the only entry needed.
- **Key rotation:** generate a new key, publish BOTH `kid`s in the JWKS during the
  overlap window, then retire the old one (verifiers pin alg per `kid`).
- **Deploy command:** `wrangler pages deploy dist` (after the one-time
  project/secrets/KV setup above). It is not yet wired into
  `scripts/deploy-cloudflare.ts` — that script auto-injects the demo URLs, but the
  Google OAuth creds + broker key are out-of-band one-time secrets.

## 2. Google Cloud Console

**APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**

- **Authorized JavaScript origins:** the Connect origin, e.g.
  `https://connect.<yourdomain>` (and `http://localhost:8788` for `wrangler pages dev`).
- **Authorized redirect URIs (must EXACTLY match `GOOGLE_REDIRECT_URI`):**
  - Production: `https://connect.<yourdomain>/oidc/google/callback`
  - Local: `http://localhost:8788/oidc/google/callback`
  (Note the path is `/oidc/google/callback` — demo-sso's Pages Function route —
  NOT smart-agent's `/api/auth/google-callback`.)
- **OAuth consent screen:** add the `openid`, `email`, `profile` scopes; add test
  users while the app is in "testing".

Copy the generated **Client ID** + **Client secret** into the Pages secrets above.

## 3. The flow (what the functions do)

```
relying site → GET  /oidc/google/start?aud=<rp>&redirect_uri=<rp-callback>
   broker: beginLogin (PKCE S256 + state + nonce) → 302 to Google
Google → GET /oidc/google/callback?code&state
   broker: completeLogin (token exchange w/ client_secret → id_token verify:
           RS256/JWKS alg-pinned, iss/aud/exp/nonce, email_verified)  [connect-auth]
        → verified (iss, sub) = a LOGIN-GRADE credential facet
        → directory.resolveByOidcSubject → issueForResolution
        → §4a: stash token under a single-use code → 302 back to the relying site with ?code
relying site → POST /token { code, aud } → { agentSession }  → verify via GET /jwks
```

**Demo resolution:** the directory is mock-seeded, so as a demo aid ANY verified
Google login resolves to the demo agent **Alice** (`buildDemoDirectory` in
`src/lib/broker-core.ts`, fenced to the Google issuer) — that's why a real Google
account that isn't pre-seeded still gets a session here. A real deployment maps a
specific `(iss, sub)` → agent via a real indexer + on-chain `confirmsCredential`,
and routes a brand-new subject to bootstrap (spec 220).

## 4. What you do NOT need (divergence from smart-agent)

smart-agent derives a **deterministic smart account from the Google user**
(email → CREATE2 salt), so it needs `OAUTH_SALT_HMAC_KEY` /
`AWS_KMS_MAC_KEY_ID_OAUTH_SALT`. **demo-sso does not.** Our model (ADR-0016/0017,
audit CN-3):

- The OIDC subject is a **login-grade credential facet keyed on `(iss, sub)`**,
  **never on email** (email is reusable → a takeover vector). The canonical agent
  is **RESOLVED** via `identity-directory.resolveByOidcSubject(iss, sub)`, not
  derived from the email.
- So there is **no `OAUTH_SALT_HMAC_KEY` here.** A salt is only relevant on the
  **bootstrap** path (0 agents → create a new SA, spec 220), and even then it is
  derived from the credential/scope (ADR-0010: salt from auth methods + scope,
  never a name/email), not the email. Bootstrap is not yet wired in this demo.
- An OIDC session is **login-grade**: it can read + act in pre-authorized bounds,
  but a custody-class action needs **step-up** to a custody-grade credential
  (ADR-0017 / CN-2).

## 5. Bringing OIDC into the other demos later

The same `@agenticprimitives/connect-auth/google` method + a server endpoint
(Pages Function / Worker) is reusable. Each app sets its own `GOOGLE_*` secrets +
registers its own callback URL in the Google Console. Keep the client secret
server-side everywhere.
