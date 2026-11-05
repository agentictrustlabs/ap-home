# Spec 445 — The Home remembers an Allow, and proves who is asking with a cookie no script can read

**Status:** written 2026-11-05. **W0–W5 live since 2026-11-05 (PR #99)**, with one item held back (`grant-cache.ts`, see W5).
Seed Bible Reader is in `shadow`; **no app skips the sheet until W4's flag moves to `on`**, after a clean week (from
2026-11-12). W6 waits on the owner's decision (§3.3). W7 is partly done: see W7. §12 lists where the build departs from the first
draft of this spec, and why. §13 answers a second agent's review, which changed the design in five places.
**Asked by:** Paul's review of sign-in (2026-11), answered point by point at
`https://faithnet.estate/architecture/sign-in#pauls-points`. This spec is the design that page says is missing.
**Builds on:** spec 230 (the grant ticket and the single-use code; SEC-001, SEC-002), spec 232 (the parent-domain
session cookie), spec 264 / ADR-0031 / ADR-0032 (FedCM and the recognized path), spec 397 W4 (the `app-grants` row),
spec 410 (a wire re-issued after rotation), spec 412 W5 (ask-as-me beside a sign-in), ADR-0019 (a scoped delegation
is the only authority a relying site gets), ADR-0055 (the vault is the record), ADR-0013 (no silent fallbacks).

All paths below are under `apps/home/`.

---

## 1. The problem

A person who allowed an app is asked to allow it again every time a sign-in reaches the Home. The Home never looks up
whether they already did.

| A person returns to an app they allowed, and… | They are asked | Is signed |
| --- | --- | --- |
| the app still holds its delegation and has used it within its id_token lifetime | nothing. No page. (`/token`, `grant_type: delegation`) | nothing |
| the app sends them to the Home, and the Home session is alive | the Allow sheet | a new delegation, and a new ask-as-me wire where the app takes one |
| the app sends them to the Home, and the Home session has lapsed | a credential, then the Allow sheet | the same |
| (Chrome, FedCM, a key the Home holds) | the browser's own chooser | a site delegation, by the server |

Rows two and three are the fault. What the code does, read 2026-11-05:

1. **The sheet is unconditional.** `RecognizedEnroll.tsx` resolves the session and goes to `ConsentSheet`. The turns
   before it are a failed session, a pinned name that does not match, the passkey host hop and the organization
   chooser. None reads a past Allow.
2. **A sign-in signs again.** `givePermission` (`src/home/onboarding.ts`) signs a new site delegation unless
   `grant-cache.ts` holds one, and that cache is `localStorage` in one browser, keyed by person and delegate, off
   whenever a session key, a payment or a vault grant rides along. An ask-as-me wire has no reuse at all. Seed Bible
   Reader (`ask_with_login`) therefore gets a new 30-day wire at every sign-in.
3. **The old wires stay live.** `/oidc/grant` replaces the person's row for that client and revokes nothing. Each
   earlier wire is still valid on chain until its own expiry and is no longer listed anywhere the person can see.
4. **The row is too thin to decide from.** `app-grants:<person>` holds `{ clientId, template, delegate, delegation,
   issuedAt, wires? }`. It does not hold what the sheet said, which claims were shared, or the ask-as-me wire minted
   beside a plain sign-in (`askDelegation` goes into the code record and is not kept).
5. **`prompt=none` cannot succeed.** `EntryExperience.tsx` answers `interaction_required` to every silent request
   from a signed-in person, for the reason quoted in the status line.
6. **The Home cannot prove who is asking without trusting page script.** The Home session is a token the page holds
   (`localStorage`, and the `ap_sso` cookie written by `document.cookie`). The server sets no cookie anywhere. The
   grant endpoints take no session at all: `/oidc/authorize-grant` and `/oidc/grant` check `Origin` and nothing else,
   because until now a signature made in that same ceremony proved the person.

Point 6 is why this cannot be a one-line lookup. Skipping the sheet means handing an app working delegations with no
signature made in the visit. Something else has to prove the person, and today the only thing on offer is a token
any script on the page can read and replay from another machine.

## 2. What Paul asked for

His message, split into requirements. §9 maps each to the work that meets it.

| | Requirement |
| --- | --- |
| **R1** | The Home stores what each Allow agreed to. |
| **R2** | On a later sign-in the **server** decides whether to skip the sheet. Not the page. |
| **R3** | It skips only when the app's registry entry asks for nothing more than was agreed. |
| **R4** | It skips only when the stored delegation still verifies on chain. |
| **R5** | Who is asking is proved by a server-set HttpOnly cookie, not the script-readable session token. |

One addition from reading the code, **R6**: a sign-in with no sheet signs nothing. The app is handed the wires it was
already given. That is what stops the pile of live, unlisted wires in §1.3 from growing.

## 3. The session

### 3.1 What the Home session is today

| | Where | Lifetime | Who can read it |
| --- | --- | --- | --- |
| The session token (an AgentSession JWT, `aud` `demo-sso`) | `localStorage` key `agenticprimitives:demo-sso:session` | **1 hour** (`ttlSeconds: 3600` in `passkey.ts`, `siwe.ts`, `email-verify.ts`, `phone-verify.ts`, `with-name.ts`, `stepup.ts`, both social callbacks). 12 hours for a demo persona. | any script on the Home origin |
| The same token, mirrored | `ap_sso` cookie, `Domain=.<CONNECT_DOMAIN>`, `SameSite=None; Secure`, written by script | cookie 30 days; the token inside it still 1 hour | any script on any host under the domain |
| The app's id_token | the app | 7 days by default, or the app's `session_ttl_seconds` | the app |
| The `oidc-deleg:<digest>` binding (lets the app renew with no page) | Home KV | the id_token lifetime, pushed out again at each silent renewal | server |

Two findings.

**The session token is also the custody token.** For a person whose key the Home holds (Google, YouVersion, email,
phone), this token is what authorizes the server to sign for them (`fedcm.ts` passes it on as `custodyToken`). So the
value in a script-readable cookie is, for an hour, the right to have the Home sign as that person. This is the
exposure the HARDENING TODO names.

**Recognition lasts one hour, not thirty days.** The cookie's own comment says "authenticated once, recognized for
weeks". The recognized path proves the session by calling `/me/profile` with the token; `verifyAgentSession` refuses
an expired token; nothing renews one. After the hour the cookie is still present and no longer works, and the person
is sent to prove a credential. The thirty days is the cookie's, never the session's. (The sign-in page on the
architecture site said thirty days; corrected with this spec.)

### 3.2 A recognition cookie the server sets

A second, separate proof of sign-in, set by the server and unreadable by script.

- **Name:** `__Secure-ap_sid`. On a plain-http dev host, `ap_sid`, host-only, no `Secure`.
- **Attributes:** `HttpOnly; Secure; SameSite=Strict; Path=/; Domain=.<CONNECT_DOMAIN>`. Strict is enough: the only
  reader is a same-origin `POST` from the Home's own page. The domain attribute is there because a passkey person
  signs in on `<label>.<CONNECT_DOMAIN>` and is recognized on `www`.
- **Value:** a random id. Its SHA-256 keys a server record `recognition:<hash>` = `{ sub, cred, auth_time, epoch }`,
  with a TTL of the cookie's own life. `cred` is the credential kind (`principal.kind`), `auth_time` is when the
  credential was proved, `epoch` is `DEPLOYMENT_EPOCH`.
- **It is not a bearer.** It is not a token at all: no verifier in the estate can be handed it by mistake, and it
  authorizes no signing and no vault read. It answers one question: *did this browser prove a credential as this
  person, and when.*
- **Only where the server checked a credential.** Possessing a link is not one: an invitation link can be forwarded and
  would plant its person in another browser, so `org-invite-redeem.ts` sets no cookie, and neither does a demo account.
  A social callback sets it only in the browser that started that sign-in (`/start` marks the browser; `state` alone is
  not bound to one). A `#session=` handoff never sets it, because no endpoint turns a token into this cookie.
- **Only a strong credential sets it.** A session of `onchain-confirmed` assurance sets it. A weaker one (`asserted`,
  login-grade) ends whatever was there, because the browser now belongs to whoever just signed in. A cross-origin
  caller (a relying app driving SIWE) gets none. A new credential replaces the old record.
- **Set in one place.** One helper adds `Set-Cookie` to the response of each handler that checks a credential:
  `connect/passkey.ts`, `siwe.ts`, `email-verify.ts`, `phone-verify.ts`, `with-name.ts`, `stepup.ts`, and the responses
  of `oidc/google/callback.ts` and `oidc/youversion/callback.ts`. `recognition.test.ts` fails when a call to `mintAgentSession` is not wrapped, and when
  anything else calls the helper.
- **Never minted from a token.** There is no endpoint that turns a session token into this cookie. If there were, a
  stolen token would buy the cookie and R5 would mean nothing. A session that exists when this ships gets its cookie
  at the person's next credential ceremony.
- **Cleared by the server.** `POST /connect/logout` deletes the record and answers with `Max-Age=0`; `/logout` calls it
  before it walks the relying apps, and so do "Not you?" and a forced chooser. Script cannot clear an HttpOnly cookie, so
  without this a sign-out would leave it behind. Because the record is gone, a copy of the cookie is worth nothing.

The existing token and `ap_sso` stay as they are in this spec. The page still needs a bearer for the portal, and
FedCM still reads `ap_sso` cross-site. Moving those is W7.

### 3.3 How long recognition lasts — an owner decision

| | Lifetime of the recognition cookie | What a returning person meets at the Home |
| --- | --- | --- |
| **A** | 1 hour, the same as the session it is minted beside | within the hour: nothing. After it: their credential, then nothing. |
| **B** | 30 days, absolute, from `auth_time` | for 30 days in that browser: nothing. |

Under **A** nothing about how long a browser is trusted changes. Remembered consent still removes the sheet from
every return, because a lapsed session sends the person through a credential and the cookie is fresh when they come
out. That is one prompt where there are two today.

Under **B** recognition does what the cookie comment always said it did. The cost is that a browser left signed in
can sign into already-allowed apps for 30 days. Three limits go with it:

- The cookie alone never signs and never reads a vault. It can only cause the Home to re-issue wires the app was
  already given, to that app's registered redirect, for apps the person allowed.
- Sign-out must be real. Logout already deletes the server record; "Sign out everywhere" in Security would add a
  `not-before` time for the person.
- An app registered for name or email claims needs the person's profile, which only a live session can read. With
  no live session such a sign-in is not remembered (`claims_need_session`); the person proves a credential and then
  passes without a sheet. A remembered sign-in carries exactly the claims a sheet sign-in would, or it does not happen.

**Decided by the owner, 2026-11-05: A, one hour.** B is looked at again (W6) once shadow numbers show how many Home trips arrive
after the hour.

## 4. The consent record (R1)

**What an Allow agrees to is computed, by one function, from the registry.** `termsFor(client, template)` returns:

```ts
interface ConsentTermsV1 {
  v: 1;
  clientId: string;
  template: 'site-login' | 'ask-as-me';
  delegates: { site: Address; ask?: Address };   // the registered keys the wires name
  claims: { name: boolean; email: boolean };     // sharesProfileName / sharesEmailClaim
  ask: boolean;                                  // an ask-as-me wire (the template, or ask_with_login)
  readGrant: string[];                           // read_grant.resources, sorted
  libraryFolders: string[];                      // sorted
  selfVault: { server: string; resources: string[]; ops: string[] } | null;
}
```

The consent sheet renders its "can" and "cannot" lines from this object, and the server stores this object. What was
shown and what is compared are then the same thing by construction, not by two lists kept in step.

**The row.** `/oidc/grant` already writes `app-grants:<person>`. It writes more:

```ts
interface AppGrantRowV2 {
  v: 2;
  clientId: string; template: string; delegate: Address; issuedAt: number;   // as today
  delegation: Delegation;                       // as today: the site wire
  wires?: ActWire[];                            // as today: act-as-me
  terms: ConsentTermsV1;                        // computed on the server, never taken from the request
  termsDigest: Hex;                             // keccak of the canonical JSON
  askDelegation?: Delegation;                   // now kept
  selfVaultGrant?: Delegation;                  // now kept
  origins: string[];                            // redirect origins this Allow has been delivered to
  lastUsedAt: number;
  superseded?: Array<{ ref: Hex; kind: 'site' | 'ask' | 'vault'; validUntil: number | null; wire: Delegation }>;
  askEveryTime?: true;                          // the person's own switch (§7)
}
```

- A row with no `terms` (every row that exists today) is "no remembered consent". The person meets one sheet, and
  that sheet writes a v2 row. There is no backfill.
- The stored terms say what the wires actually carry. A registry that declares an ask wire on a sign-in that did not
  mint one stores `ask: false`, so the next sign-in asks rather than handing back nothing.
- When a sheet replaces a row, the wires it replaces move to `superseded`, kept whole because revoking takes the wire,
  so Connected Apps can list them and the person can revoke them. Expired ones drop off; at most twelve are kept.
- **Who writes it.** The server, in `/oidc/grant`, and only beside the recognition cookie of the person whose wire it
  is. That endpoint checks `Origin`, which only a browser cannot fake, and a wire, which an app already holds; replayed
  from a server, it would otherwise write today's terms over a signature made under narrower ones. Without the cookie
  the row lists the wires and remembers nothing. The page never writes terms, so a tampered page cannot forge an Allow.
- The row stays what spec 397 says it is: **a pointer that can be rebuilt**. The wires are the record, held by the
  app and checkable on chain. Losing the row costs the person one sheet. It holds no name, no email, nothing sealed.
- The person's own copy of what they agreed to belongs in their vault. Today it is `connected-apps.ts`, a
  `localStorage` list in one browser. Moving it is W7. The server cannot read a vault record sealed under the
  person's key, least of all on a silent request for a passkey person, and a record the page wrote proves nothing. So
  **the decision is never made from the vault**: the vault copy is for the person to read.

## 5. The decision (R2, R3, R4)

### 5.1 The endpoint

`POST /oidc/remembered`, same origin only (`Origin` equals the issuer, and `Sec-Fetch-Site: same-origin` when the
browser sends it).

Request: what `/oidc/authorize-grant` takes today (`client_id`, `redirect_uri`, `delegation_template`,
`code_challenge`, `code_challenge_method`, `nonce`, `agent_name`, `prompt`, `session_key`, and the registry-gated
`profile_name` / `profile_email`).

It answers one of:

- `401 { error: 'login_required' }` — no recognition cookie, or one that is expired, revoked, or from another
  deployment epoch.
- `200 { consent_required: <reason> }` — the person is known and the sheet must be shown. Always with a reason.
- `200 { code }` — a single-use code, bound to the PKCE challenge, the client and the redirect, exactly as
  `/oidc/grant` issues one.

### 5.2 The rule

Every line must hold. The first that fails names the reason.

| # | Check | Reason when it fails |
| --- | --- | --- |
| 1 | The client's registry entry has `remembered_consent: 'on'` | `client_not_enabled` |
| 2 | The request is valid as `/oidc/authorize-grant` judges it: known client, exact redirect, allowed template, S256 | a `400`, as today |
| 3 | The template is `site-login` or `ask-as-me`, and the client does not mint a payment leg in its sign-in (`paymentConfig`, or a coin granted at connect). Never a payment, a deploy, a ceremony or act-as-me | `template_ineligible` |
| 4 | `prompt` is not `consent` | `prompt_consent` |
| 4a | `prompt` is not `login` or `select_account`. The page's chooser does not catch every such request, so the server refuses them itself | `prompt_login` |
| 5 | No `session_key` in the request (v1; see §10) | `session_key_requested` |
| 5a | No `via_host`. The sheet for such a request names the host ("Claude"), so an Allow for one host is not an Allow for another | `via_host_requested` |
| 5b | The person the page believes is signed in is the cookie's person | `session_mismatch` |
| 5c | A `prompt=none` request names the person it expects (`login_hint`), and it is the cookie's person | `silent_person_unconfirmed` |
| 6 | A row with `terms` exists for this person and client, without `askEveryTime` | `no_record` / `ask_every_time` |
| 7 | If `agent_name` is pinned, it is the cookie's person, by the directory | `pinned_name_mismatch` / `directory_unavailable` |
| 8 | The redirect's origin is in the row's `origins` | `new_origin` |
| 9 | `covers(row.terms, termsFor(client, template))` | `terms_widened` |
| 10 | Every wire the response would carry is this person's, names the registered key, and verifies **now**: `verifyDelegation` (the account's own ERC-1271 or approved digest, not revoked, inside its window). A chain that cannot be read is said as such, and is not called a revocation | `wire_invalid` / `wire_revoked` / `chain_unavailable` |
| 10a | Every such wire carries what the template builds today, the time window aside (from the same builder that makes the wire) | `caveats_changed` |
| 11 | Every such wire outlives the id_token about to be minted | `wire_expiring` |
| 12 | Name and email claims the registry scopes were read by the page: a blank answer means the person has none, an absent one that it could not read | `claims_need_session` |
| 13 | The audit entry was written (spec 291, audit first) | `audit_unavailable` |

The return address the person saw is the origin (check 8): that is what the sheet shows them, so it is what is compared.

`covers(stored, now)` is a pure function with its own tests. It is true when the client and template are the same,
every delegate key is the same key, `now` asks for no claim `stored` did not grant, `now.ask` implies `stored.ask`,
`now.readGrant` and `now.libraryFolders` are subsets of the stored lists, and `now.selfVault` is no wider. An app
that asks for less is covered. An app that asks for one thing more is not.

Check 10 is on chain at the moment of the sign-in. A person who revoked the wire from Connected Apps an hour ago
meets the sheet. The row is never trusted for that; it only says which wires to check.

### 5.3 When it says yes

The server writes the audit entry, mints the id_token (the client's lifetime, the request's `nonce`, the same claims as
`/oidc/grant`, the name from the directory rather than the page), writes the `oidc-deleg:<digest>` binding again, sets
`lastUsedAt`, and stores `oidc:<code>` with the wires from the row: only those the registry still asks for. `/token` is
untouched, and the app receives the same response shape as after a sheet. The app cannot tell the two apart and does
not need to.

Skipped with the sheet: the steps after a grant that can prompt or sign (`activateVaultIfNeeded`, the community
messaging leg, a read grant). They ran at the Allow. The playbook self-heal still runs for an `ask_with_login` app,
because it signs nothing and an app's first ask fails without it.

Nothing is signed. No userOp is sent. No wire is created (R6).

### 5.4 When it says no

The page shows the sheet, and the sign-in goes on as it does today. This is not a silent fallback (ADR-0013): the
reason is in the response, in the control event, and in the page's console line, and the person sees the sheet that
the reason calls for. `terms_widened` also changes the sheet's heading to "<App> is asking for more", with the added
lines marked.

## 6. The page

- **`RecognizedEnroll.tsx`** calls `/oidc/remembered` once the request is parsed, before the sheet and **before the
  passkey host hop**. Nothing is signed on this path, so a passkey person has no reason to leave `www`.
- While the call runs, for an app set to `on`, the person sees one line: "Signing you in to <App> as <name>", with
  "Not you?" beside it. "Not you?" ends the session and the cookie and opens the credential chooser; an answer that
  arrives afterwards is not delivered. An app in `shadow` or off keeps the old "getting your home" line, because the
  sheet follows. On a yes the page delivers the code the way it does now (popup message, or redirect).
- **`EntryExperience.tsx`, `prompt=none`:** calls the same endpoint. A code comes back only for the person the app named
  in `login_hint`, who allowed it before. **Every other case is the same `login_required`:** no session, the wrong person,
  never allowed. A code without a named person would tell any allowed app who just walked in, with no "signed in as" on
  screen for a leftover session to be caught by; an answer that varied would tell any registered app whether this
  visitor has a Home session at all. This replaces `interaction_required`, which said exactly that. No app sends
  `login_hint` yet, so nothing is silent until one does.
- **After a credential.** A person with no session proves one and re-enters the recognized path, as today. The
  cookie is now set, so the same call is made and the sheet is skipped for an allowed app.
- `prompt=login` and `prompt=select_account` end the session and ask for a credential, once, whether or not the request names
  a Home. Then the sheet: they never skip it (check 4a), and the request does not loop. Until 2026-11-05 a request naming no
  Home did not get the credential prompt, because `EntryExperience.tsx` marked the chooser done first.

## 7. What the person controls

- **Connected Apps** (`/grants`) lists, for each app, what it may do (from `terms`), when it was allowed, when it
  last signed in, and every live wire including the superseded ones, each with Revoke.
- **Revoke** is on chain, as now. The next sign-in fails check 10 and shows the sheet.
- **Forget this app** drops what was agreed (`terms`, `origins`), so the next sign-in shows the sheet. The row and its
  wires stay listed: they are still live on chain, and a row that vanished would take the only place to revoke them.
- **Ask me every time** sets `askEveryTime` on the row.
- **Activity** shows each remembered sign-in: "Signed in to <App>. No new permission." The control-plane event types are
  a Ring 0 enum with no word for this, and `grant-issued` would be false, so it is a short list of its own beside the
  timeline (`remembered-log:<person>`, capped, 90 days), a projection of the audit entry. A package event type would
  fold it into the timeline.

## 8. Security

| Threat | Today | With this spec |
| --- | --- | --- |
| A stolen session token, replayed from elsewhere | An hour as that person. For a Home-held key, the Home will sign a new delegation. For a passkey or wallet person, nothing can be signed. | The same, and no more. `/oidc/remembered` does not accept the token, so a passkey or wallet person's existing wires cannot be collected with it. This is what R5 buys. |
| Script running on the Home page (XSS) | Reads the token; sees every code the page delivers. | Cannot read the cookie. Can call the endpoint while it runs, for apps the person already allowed. Bounded to that browser and that moment. §10.3 closes it further. |
| Another site posting to the endpoint | — | `SameSite=Strict`, the `Origin` check, and a JSON body a form cannot send. |
| A sign-in link planted in a victim's browser (a callback the attacker prepared, a forwarded invitation, `#session=`) | Signs that browser in as the attacker; the sheet then says whose session it is. | A social callback is refused in any browser but the one that started it (W7). A forwarded invitation or `#session=` still opens a session, and sets no recognition cookie, so no sheet is ever skipped on one. |
| An app's id_token presented as a Home session | `verifyHomeSession` retried under whatever audience the token named, and nothing checked for a credential, so FedCM took it. | **Fixed here:** a session must name its `principal` (`fedcm.ts`, `me/handler.ts`). The recognition cookie was never exposed to this: it is not a token. The Home's own audience cannot be an app id. |
| A held wire replayed at `/oidc/grant` to forge consent | — | Terms are stored only beside this person's cookie (§4). |
| An app's registration changes to ask for more | The sheet is shown anyway. | Check 9. The sheet is shown and says what is new. |
| A registration gains a redirect on a new origin | — | Check 8. A code is never sent to an origin the person has not allowed through. |
| Several apps share one delegate key | The reuse cache is keyed by delegate, so one app's wire can stand for another's. | The row is keyed by client. `grant-cache.ts` is retired (W5). |
| A host under the parent domain that is not the Home | Receives `ap_sso` and can read it. | Receives the recognition cookie on requests to it. W0 found none on faithnet: see below. A new one needs this row re-read. |
| A redeploy that resets the chain | `epoch` drops the session. | The cookie carries `epoch`; check 10 fails on every wire regardless. |

## 9. Work

Each item is a pull request that leaves sign-in working. The Home deploys only by GitHub to Vercel.

- **W0 — Measure.** *Built:* `/oidc/remembered` is called on every eligible trip, for every client, and counts each
  outcome by day, client and mode (`remembered-stat:*`; read with `apps/home/scripts/remembered-stats.mts`). An app that
  is off gets no chain read and is still counted, under the reason it would have failed, so which clients send
  `session_key` and how many trips arrive with no live recognition will come from these numbers once deployed. Gather27
  is known already: it sends `session_key` on every sign-in, so it keeps the sheet (§10.2).
  *Hosts under `.faithnet.me`, read 2026-11-05:* the apex, `www`, and every other name tried (`a2a`, `api`, `mcp`,
  `vault`, an invented label) all answer from Vercel, the wildcard to the Home app. Nothing else is served there, so W1
  is not blocked. The estate's agents are on separate domains. The other estate's Home domain has not been read, and must
  be before its clients are turned on.
- **W1 — The recognition cookie** (§3.2), lifetime A. *Built:* the helper, the wrap on every mint site, `POST
  /connect/logout`, `/logout` calling it. *Done when:* a sign-in by each credential kind sets the cookie; script
  cannot read it; sign-out removes it; the test that finds an unwrapped mint passes. **R5.** (The test passes. The rest
  is checked after deploy.)
- **W2 — Terms and the row** (§4). `termsFor`, `covers`, the sheet rendered from terms, the v2 row written by
  `/oidc/grant` with `askDelegation`, `selfVaultGrant`, `origins`, `superseded`. *Done when:* a sign-in to Seed Bible
  Reader leaves a row holding both wires and the terms the sheet showed; `/connect/app-grants` returns v1 and v2
  rows alike. **R1.**
- **W3 — The endpoint, in shadow** (§5). `remembered_consent: 'shadow'` on a client makes the endpoint decide, write
  the event, and answer `consent_required: shadow`. The page calls it and shows the sheet regardless. *Done when:* a
  week of events for Seed Bible Reader shows yes for returning people and a named reason for every no. **R2, R3, R4.**
- **W4 — Turn it on for one app** (§6). `'on'` for `seed-bible-reader`; the page path; `prompt=none`. *Done when*
  (the live gate): allow the reader, sign out of the reader only, sign in again — no sheet, no transaction, the
  same wire `ref`s in the token response. Revoke the ask wire, sign in — the sheet. Add a claim to the registry
  entry on a preview — the sheet, with the new line marked. Replay the session token from another machine against
  `/oidc/remembered` — `401`. **R6.**
- **W5 — The person's controls, and one mechanism** (§7). Connected Apps shows terms, last use and superseded
  wires; Forget; Ask me every time. *Built,* except that **`grant-cache.ts` stays for now.** It saves a signature for
  every app that is not on, and removing it before they are would make their sign-ins worse. It goes when the last
  client it serves is on. Member-registered clients never remember (§10.4), so that is not soon. The remaining
  curated clients are turned on one at a time; `remembered-consent.test.ts` makes each one a reviewed change.
- **W6 — How long recognition lasts** (§3.3, B). Only on the owner's decision. "Sign out everywhere" goes with it. (The
  comment in `sso-cookie.ts` is corrected already.)
- **W7 — After.** *Done:*
  - **FedCM no longer signs a delegation for an app the person never allowed.** `/fedcm/grant` hands a Home-held-key person the
    wire stored at their last Allow, under the same rules (§5.2, for the one wire this lane returns), and sends everyone else
    to the popup with the `needs_device_credential` answer every relying client already falls back on. The first draft said
    this lane should read the recognition cookie. It cannot: that cookie is `SameSite=Strict` and never rides FedCM's
    cross-site requests. So the proof here stays `ap_sso`, which is why a device credential stays out: a stolen token must not
    collect those wires. A Home-held key is different, because that token could already have the Home sign. Demo accounts keep
    their fast path. Consequence on merge: a Google or YouVersion person's first FedCM connect to each app is now a popup.
  - **A social sign-in finishes only in the browser that started it.** Refused (`sign_in_started_elsewhere`) before anything is
    asked of the provider. A connector authorization is exempt, being bound to the Home session that started it. Consequence: a
    deployment whose host is not under `NEXT_PUBLIC_CONNECT_DOMAIN`, and which starts and returns on different hosts, cannot
    complete a social sign-in. That includes Vercel previews.

  *Later:* the portal's bearer endpoints move to a server-set session, and `ap_sso` goes. The person's list of allowed apps moves
  from `localStorage` into their vault.

Tests that must exist before W4: `covers` (same, narrower, each way of being wider); each row of §5.2 returns its
reason; a revoked wire and an expiring wire each force the sheet; the code from a remembered sign-in exchanges at
`/token` under PKCE and under no other verifier; a v1 row is `no_record`.

## 10. Open questions

1. **Recognition lifetime**, §3.3. Decided: A now, B on numbers.
2. **A request with `session_key`.** v1 shows the sheet, and Gather27, which sends one on every sign-in, keeps it. Design in §15,
   not built.
3. **Should script see the code at all?** In redirect mode the endpoint could be a form `POST` that answers `303` to
   the app, so a script on the Home never holds a code. Popup mode delivers by message and cannot do this. Worth
   doing if W0 shows redirect is the common mode.
4. **Member-registered clients: decided, they always ask.** Their owner can change the delegate at any time, and nobody
   at the estate reviewed them. `toOidcClient` drops the flag, so there is nothing to turn on.
5. **Re-signing only the part that lapsed.** When only the 30-day ask wire is near its end, v1 shows the whole sheet.
   A smaller "Renew <App>'s access" step is possible later.

## 11. Paul's points, and where each is met

| Paul wrote | Met by |
| --- | --- |
| "The Home never checks whether a person has already allowed an app" | §5, W3, W4 |
| "every sign-in gets a new delegation" | §5.3 and R6: a remembered sign-in signs nothing and hands back the stored wires |
| "the app-grants row from the last Allow is already there" | §4: the row gains the terms and every wire, so it can be decided from |
| "the Home stores what each Allow agreed to" | §4, W2 |
| "the server skips the sheet only when the app's registry entry asks for nothing more" | §5.2 check 9, `covers` |
| "and the stored delegation still verifies on chain" | §5.2 checks 10 and 11 |
| "a server-set HttpOnly cookie proving who is asking instead of the script-readable session token" | §3.2, W1, and it lands before anything is skipped |

## 12. Where the build departs from the first draft

| The draft said | Built | Why |
| --- | --- | --- |
| The cookie holds a signed JWT, with a `sid` revocation list | A random id whose hash keys a server record | It cannot be confused with a token anywhere, a store leak yields no cookie, and sign-out is a delete. The cost is one KV read at the decision, which already reads the row. |
| Forget drops the row | Forget drops the terms and keeps the row | The wires are still live on chain. A dropped row leaves them live and unlisted, which is the fault in §1.3. |
| `superseded` holds a ref | It holds the whole wire | Revoking on chain takes the wire. |
| A control event | A short list of its own, beside the timeline, under an audit entry | The event types are a Ring 0 enum, pinned here. `grant-issued` would say something false. |
| `grant-cache.ts` is removed in W5 | It stays until the last app it serves is on | See W5. |
| Twelve checks | Five more reasons: `via_host_requested`, `session_mismatch`, `directory_unavailable`, `chain_unavailable`, `audit_unavailable`; and a payment leg on a plain sign-in makes the client ineligible | Each is something the code does that the draft had not read. A skipped sheet must not re-mint money authority, nor carry an Allow for one host to another. |

Found on the way and fixed: `/connect/app-grants` read a wire's end date as if its terms were `uint128 ‖ uint128`. The
encoder writes two `uint256` words, so Connected Apps was showing the wire's `validAfter` as its "until". It now reads the
terms with the package's `decodeTimestampTerms`.

The sheet also says two things it did not before, for an app registered for them: that the app may ask the person's agent
as them, and what it may read. Both were being granted without being said, and what is stored must be what was shown.

Found and left: on the plain recognized path the reader's declared `read_grant` is not issued. Only the `ask-as-me`
template and the Google resume path issue it. That predates this spec and is unchanged by it.

## 13. The second review, answered

A second agent, working the same problem independently, raised these. Each was read against the code.

| It raised | Finding | What changed |
| --- | --- | --- |
| The cookie can be planted: Google and YouVersion sign-in are not bound to the browser that started them, and `#session=` is accepted | **Correct, and the draft and first build had it.** Also true of invitation links, which it did not name. | Social callbacks recognize only the browser that started them. Invitation links and demo accounts set no cookie. `#session=` never could. §3.2, §8. The session itself can still be planted, as today: W7. |
| An app's id_token can pass as a Home session | **Correct, and worse than stated.** The cookie is not exposed, being opaque. But `verifyHomeSession` retried under the token's own audience and nothing checked for a credential, so by reading the code, any app holding a person's id_token could present it at `/fedcm/assertion` and receive a token for a different app. Not tried against a live Home. | A session must name its `principal`. The Home's audience cannot be registered as an app. §8. |
| Terms in the vault: can the server read them silently, and who writes them? | **The server cannot, and the decision is not made from the vault.** The row is written by the server. But the review's question led to a real gap: `/oidc/grant` would write terms for anyone replaying a held wire. | Terms are stored only beside the person's cookie. §4. |
| "Asks for nothing more" needs more than claims | Delegate, life left and `prompt=consent` were built. Caveats were not. | `caveats_changed`, from the same builders that make the wires. Member-registered apps always ask. The return address stays the origin, because that is what the sheet shows. §5.2, §10.4. |
| `prompt=none` tells an app who the visitor is, and shows no "signed in as" | **Correct.** | The app must name the person, and every other case gets one answer. §6. |
| `session_key` cannot skip; Gather27 sends one every time | **Correct, and already refused** (`session_key_requested`). Gather27 is not helped by this spec. | Recorded. §10.2. |
| FedCM already gives a delegation with no sheet, on the script-readable cookie | **Correct.** | Fixed in W7: the stored wire or the popup. |

## 14. Tested in a real browser

`tests/e2e-local` runs the real production build in Chromium with an in-memory KV and a scriptable chain, with the reader
`on`, another app in `shadow` and a third off: real cookies, pages and token exchange, no gas, no model. It found what the
unit tests could not:

- **`prompt=login` passed straight through** on a request naming no Home, returning a code. Check 4a.
- **A remembered sign-in left the app off this device's "Apps you signed into".** Now recorded.
- **The "Ask me every time" checkbox** did not respond until the server answered. Now immediate, and a failure is said.

It cannot reach a real wallet, the real chain, the `Allow` click itself (signing needs a bundler; the wires are built by the
Home's own builders and accepted by the fake chain), `__Secure-` and `Domain` attributes (https only; unit-tested), or a
social provider's return. W4's live gate is still what proves those.

## 15. Design, not built: remembered consent for an app that sends a session key

**The problem.** The app makes a new key at each sign-in and needs a leaf delegation (spec 270) from the person to that key. A leaf is
a new signature, so there is no stored wire to hand back, and check 5 keeps the sheet. Gather27 sends one on every sign-in.

**The proposal.** Treat the leaf as part of what an Allow agrees to, and sign it without a sheet only where that is not a device prompt.

- **Terms gain `sessionLeaf: { maxSeconds, caveats digest }`,** from the registry, shown on the sheet ("Stay signed in on this device for
  up to N hours"), and compared by `covers` like everything else. A leaf is stored by nobody: only the right to ask for one is.
- **A person whose key the Home holds:** when every line of §5.2 holds, the server signs the leaf for the request's public key under the
  remembered Allow, through the custody bridge's constrained sign, which builds the leaf itself and signs nothing else. The home still
  never holds the session's private key.
- **A passkey or wallet person:** a leaf needs their device. They get one prompt with no sheet ("Confirm it's you"), not a skipped
  signature. It removes the reading, not the gesture. This needs the same page path, so it can follow.
- **The cookie is the proof,** as everywhere: a stolen token gets nothing. The audit entry names the leaf.
- **Shadow first,** as in W3, with `session_key_requested` becoming `would: 'allow'`.

**To check before building.** The owner's own Gather27 does not need a new key on every sign-in (2026-11-05). So a stored leaf and no new
signature looks simpler than anything above, and keeps the rule that a skipped sheet signs nothing. The real Gather27 runs on a separate
estate, and has not been read: confirm it there first. Its registration and this spec's rollout are that estate's to decide.

## 16. A sign-out that reaches every app

**The problem.** The Home's sign-out walked a default list of three apps by top-level navigation. Every other app stayed signed in on its own
token and could renew it silently. Asked to reach all of them, the obvious change is wrong: adding an app to the walk navigates the person to
it, and an app that does not send them back strands them there. Read in a real browser on 2026-11-05, loading each `/sso-logout` with a return:

| | Apps |
| --- | --- |
| **Signs out and returns** | `heartcoach.faithnet.io`, `gamenight.faithnet.io`, `bible.faithnet.io`, and `faithnet.estate`, added here |
| **Signs out, does not return** (lands on its own root) | `commons-production…workers.dev`, `field-web…workers.dev`. Both were in the default walk |
| **No sign-out page** (serves its ordinary page, or redirects, or a 404) | `church`, `town`, `skills`, `workbench`, `coach`, `seed-reader`, `publishing`, `reader`, `names` (all `.faithnet.io`), demo-terms, engage-web, demo-web and demo-web-pro, skills-corpus, demo-corpus, uupg-tracker, campaign-studio, org-site, newcity-portal, openbook-tyndale |
| **Behind their own gate, not read** | `engage.global.church`, `platform.global.church` |

Not walked by design: `home-mcp` has no browser session. Not reachable: demo-org, demo-jp, demo-gs.

**What reaches every app now, with no change to any app: renewal ends.** `POST /connect/logout` with `everywhere` deletes the
`oidc-deleg:<digest>` binding of every wire on the person's rows, current and older. An app's next silent renewal at `/token` fails, so it must send
the person to the Home, where they meet a credential. It takes the recognition cookie, or a real Home session: an id_token does not pass, so an app
cannot sign a person out of the others. "Not you?" and a forced chooser end the cookie and leave the apps alone.

**What it cannot do.** An id_token already issued stays valid to its own expiry, up to 7 days, for whichever app holds it. The Home cannot recall a
token an app holds, and a wire on chain is untouched: signing out is not revoking. So an app with no sign-out page shows the person signed in until
its token lapses or it next tries to renew.

**The walk is now a verified list,** `whitelabel.frontChannelLogout`, by Home origin, replacing the env default and a hardcoded origin for that Home.
`tests/e2e-sso/logout-chain.spec.ts` loads each entry the way the chain does. Another Home keeps the older walk until it has a list of its own.

**The rest is each app's own change.** An app joins by serving `/sso-logout`: clear its own session, then redirect to `return` when that is on its Home's
`/logout`. `apps/estate/assets/sso-logout.js` is the shortest example, including how a sign-out reaches a session in another tab. Commons and Field-web
need only their return allowlist fixed. When an app returns, add it to the list.
