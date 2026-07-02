# Spec 299 — Recommended onboarding: person + organization (UX-informed)

**Status:** Draft for external audit + UX design · **Architect-of-record:** this spec (consolidates the experience
layer of [spec 297](297-badges-and-org-creation-onboarding.md) — badges + org creation — and
[spec 298](298-impact-home-person-connect-onboarding.md) — person connect).
**Apps:** `demo-sso-next` (**Impact Home**, `impact-agent.me`) · `demo-gs` (relying app + approver console).
**Inputs folded in:** a full UX-designer pass (2026-06-30) over 297/298; house principles — "value steps ≠
signatures", "custodian backs all authority" (spec 294), relying⇄IdP split (spec 259). **ADRs:** 0010, 0021, 0023/24,
0025.

> Purpose of this doc: a single **recommended** end-to-end experience to hand to the **external audit** and the
> **UX design** pass. 297/298 remain the mechanism-of-record (credentials, contracts, approval gate); **299 is the
> experience-of-record** and resolves the UX gaps found in them (see §9).

## 1. Recommendation in one paragraph

Move all name/credential work out of demo-gs into **Impact Home**; demo-gs shows one nameless CTA. In Impact Home,
onboarding is a **badge journey**: a person connects **social-first** (Google / YouVersion primary; passkey / wallet
secondary), lands in a **badge wallet** that shows the whole path, and earns badges as distinct **value steps** —
**Connected → Profile → Org-Email** — then (separately, only when they choose) **Org**. Badges are held Verifiable
Credentials surfaced as earned tokens. Org creation is **crowd-matched** (search the church/people directory by name +
email domain) and **approval-gated** by Pete / the Global.Church group (**deploy-on-approval**). Every step is copy-led
("confirm your profile", not "deploy your SA"), device-prompt-minimal (0 prompts on the social path until a real
consent), and resumable.

## 1a. Reference: smart-agent patterns to port

This spec consolidates the experience layer of 297/298 and inherits their smart-agent lineage rather than introducing
a new port: **credential-as-gate** (capability gated on held credentials, not app flags — the badge wallet is the
presentation of that), **joint two-party attestation** (org SA + person SA co-sign the Org association; ported as
`packages/attestations`), and **connection-custody-backed authority** (spec 294). See [spec 297 §2](297-badges-and-org-creation-onboarding.md)
and [spec 298 §1a](298-impact-home-person-connect-onboarding.md) for the detail. **Deliberate divergence** (ours, not
smart-agent): the social-first badge journey, the crowd-KB matching step, and the Pete/Global.Church approval gate.

## 2. The badge journey (mental model)

```
 Connected ──▶ Profile ──▶ Org-Email ─┊─▶ Org
 (on connect) (verify     (work email   (crowd-matched +
              name/email)  proven)        approved)
                                   ▲
                     person onboarding ends here (spec 298);
                     org onboarding (spec 297) begins on demand
```

Badge = a held VC (spec 297 §3). The wallet shows **all** badges on arrival (held / earnable / pending / not-approved
/ revoked) so the person sees the journey, with an earn CTA only on the current step. **Every badge state uses color
AND icon AND a text label** (WCAG 1.4.1). Locked badges always show a plain-language 1-line description (so a locked
badge is never an opaque obligation). Descriptions live in white-label config (ADR-0021):

- **Connected to Impact Home** — anchored at top, always held, no CTA.
- **Profile** — "Confirms your name and email address."
- **Org-Email** — "Proves you have a work email at an organization." (display label may read "Work Email" — §10 D.)
- **Org** — "Links you to your church's organization on Impact."

## 3. Person onboarding — recommended screen map

| # | Screen | Primary action | Key UX notes |
|---|--------|----------------|--------------|
| 0 | demo-gs entry | **Connect Impact Home** | one nameless button; one line of what it does |
| 1 | Social-first chooser | **Continue with Google** / **YouVersion** (equal primary) | passkey/wallet under "Other ways to connect"; OAuth error returns inline |
| 2 | Connecting | — (auto) | spinner + "Starting your Impact Home…"; never a blank screen; deploy via Google-KMS custody |
| 3 | **Badge wallet — arrival** | **Verify your profile** | first-visit narrative beat (heading+sub above list); Connected badge held; Profile/Org-Email shown locked; 3-dot progress; "Return to demo-gs" ghost always present |
| 4 | Verify profile | **Confirm profile** | first/last/email **prefilled** from claims, editable; "✓ Google/YouVersion" chip on verified email; handle auto-suggested inline with [Edit] + availability check; success animates Profile badge locked→held |
| 5A | Org-Email (org domain) | **Confirm & earn badge** | shown when the social email is already an org domain → 0 device prompts; badge preview (domain shown, address private) |
| 5B.i | Org-Email (personal domain) | **Send verification code** | shown when social email is free (gmail/…); ask for the work email |
| 5B.ii | Enter code | **Verify code** | **single** input (`autocomplete="one-time-code"`, numeric, maxlen 6); 10-min expiry; resend with 60s countdown; OTP sent via SendGrid |
| 6 | Return to demo-gs | **Return** (auto after receipt) | ReceiptCard of what was earned; allowed after Profile (Org-Email skippable) |

**Branch detection is silent** (§5): the user never picks "is this a work email?" — the system inspects the domain
and shows the one right screen. **"Return to <app> — do later"** is on every Org-Email screen (not "Skip"/"Cancel").

## 4. Organization onboarding — recommended screen map (spec 297)

| # | Screen | Primary action | Key UX notes |
|---|--------|----------------|--------------|
| 0 | demo-gs entry | **Set up your church's organization** | nameless; opens Home with `{action:'create-org'}` |
| — | Gate check | — | both badges held → continue; else open the wallet with "complete [badge] — next step below", earn, auto-return to intent |
| A | **Crowd-match prompt** | **This is my church** / **None of these — create new** | ≤3 candidate churches (name, city, why-matched); trust note "From the public church directory. Not yet verified."; separate "Also in the directory — is this you?" person match with **Yes / Not me / Not sure** |
| B1 | Associate confirm | **Request this organization** | org name pre-filled from crowd record; "we'll store a private link in your vault" |
| B2 | Create-new | **Continue to review** | name input w/ uniqueness check; shown directly (no empty candidate list) when no match |
| C | **Review & submit** | **Submit request** | summary (name, domain evidence, crowd match, badges) + [Edit] links — *new screen, closes a spec gap* |
| D | Pending | **Return to demo-gs** | "Request submitted" (not "pending"); "What happens next" collapsed; email expectation; "View your Impact Home" link |
| E | Result (async) | — | approval → Org badge animates in; rejection → "Not approved — [reason] · Revise and resubmit" |

**Trust framing rules:** say "From the public church directory. Not yet verified." Never "We found your church" /
"Your organization"; never show KB contact/address/URLs (name + city + why-matched only). Crowd ids are hints
(`possibleSameAs`, never `owl:sameAs` — spec 296).

## 5. Approval experience (deploy-on-approval)

**User-side pending:** positive + factual ("Request submitted", the exact org name, "we'll email you at <addr>"),
collapsed "What happens next" (reviewer checks it, ~1–2 business days, approve → Org badge, may ask for more info).
Copy discipline: no "shortly/soon/quickly"; no passive "Approval pending" headline.

**Approver console** (a tab in the existing demo-gs GCO view, not a new app for W4): one row per request — requester ·
org · domain (+ "social-verified") · crowd match · badges held · **[Approve] [Reject] [Request info]**. Approve →
inline confirm naming the entity and the authority action ("This will create the organization on Impact's network and
issue Alice's Org badge — requires your Global.Church authorization"). Reject → required free-text reason (shown to the
requester). Duplicate-domain requests show an amber "an org for this domain already exists/pending — connect instead?"

**Email** (SendGrid, the OTP transport reused): transactional templates for request-received / approved / rejected.

## 6. Copy, hierarchy, accessibility (recommended standards)

- **Tone:** action-first headings ("Confirm your profile"); describe outcomes not mechanisms ("Your organization is
  connected to Impact", not "your org SA was deployed"); honest about gatekeeping ("a reviewer checks your request").
- **Banned in user copy:** smart account, ERC-4337, delegation, vault, credential/VC, custodian, passkey ceremony,
  and "simply / just / easy / quick". "Impact Home" always two words, capitalized.
- **Hierarchy per screen:** one h1 (what this accomplishes) → one sub (why / what's next) → content → primary →
  secondary. ≤2 paragraphs body. Trust disclosures live under "More about this badge".
- **Accessibility:** ≥44×44px targets; state = color+icon+text; `role="alert"` errors with a non-color prefix;
  OTP countdown `aria-live="polite"`/`aria-atomic` (update ≥5s granularity); spinners keep `role="status"`+aria-label;
  badge card = `<article><h3>`, wallet = `<section aria-label="Your badges">`, candidates = `<ul><li><button>`;
  body contrast ≥4.5:1.

## 7. Device-prompt budget (a first-class design constraint — "value steps ≠ signatures")

| Path | Person onboarding (→ Org-Email) | Through Org badge |
|------|----|----|
| Google / YouVersion | **1** (OAuth consent only) | **1** |
| Passkey | 1–2 | 2–3 |
| Wallet | 2 | 3 |

Rules: social path issues Profile + Org-Email **server-side via the KMS session** (0 extra prompts) — confirm the
`activateVaultIfNeeded`/session-token path (spec 278) covers badge issuance without a fresh assertion. Org-Email badge
is **always** Home-attested → 0 device prompts for everyone. For passkey/wallet, **always** show pre-prompt copy
("One tap to save your profile") before any assertion — never surprise a prompt. Org deploy on approval is one clearly
pre-explained tap.

## 8. Independence & brand

- **New parallel flow** (`onboarding.flow: 'impact-connect' | 'legacy'`, default legacy; Impact config opts in). New
  `components/onboarding/impact/` journey; **no edits** to legacy `EntryExperience`/`OnboardingJourney`.
- **Brand is already "Impact"** (`brand.name`); finish the sweep of stray "Global.Church" copy/comments → "Impact";
  keep `DEMO_SSO_AUD` + `impact-agent.me`.

## 9. Spec gaps this recommendation closes (from the UX pass)

**P0 (must fix before ship):**
- **OTP rate-limit + resend** undefined → 60s client countdown; server max 3 OTP/email/hour (KV); escalate to Security
  before the OTP step ships.
- **No "Return to parent" on Org-Email screens** → ghost "Return to <app> — do later" on every Org-Email screen.
- **No arrival narrative** before the badge wallet → first-visit heading+sub card above the list.
- **Org-Email earn idempotency** → guard: if badge `held`, show "already earned", never re-run OTP.

**P1 (soon):** handle-claim timing (recommend: claim at profile-verify, auto-suggest + edit); locked-badge
descriptions (config; drafted §2); **approver SA custody model** (Pete KMS vs device — drives console prompts;
escalate to Security); person-match needs **"Not sure"**; "My church isn't listed" link beside each candidate;
**approval/rejection email** mechanism (SendGrid templates in W4 scope).

**P2 (polish):** badge earn animation; **review-before-submit** screen (added as Step C §4); non-ASCII handle
fallback; reconsider "Org-Email" label → "Work Email"; deterministic `<handle>.impact-agent.me` link on pending.

## 10. Decisions — RESOLVED 2026-07-01 (were open for audit)

1. **YouVersion login email → RESOLVED: identity-only.** Confirmed against spec 265 §intro: the YouVersion `/token`
   exchange's `id_token` yields only `(iss, sub)` — **no email, no reliable name**. Therefore the **YouVersion path
   always lands in profile-verify with empty first/last/email** (user types them), and its Org-Email step **always**
   uses the entered work email (Branch B / OTP) — never the social-email auto-branch. **Google** remains the path that
   pre-fills name + email and can auto-grant Org-Email when its email is already an org domain.
2. **`.agent` handle timing → RESOLVED: claim at profile-verify.** Auto-suggest `first-last.impact` with inline
   [Edit] + availability check; the Profile badge anchors to the claimed `.agent` name (ADR-0010 — the SA's canonical
   public facet). Deferring would leave the Profile badge un-anchored. (Closes spec 298 §8.2.)
3. **Org-domain detection → RESOLVED: free-domain denylist first; crowd-KB cross-check later.** W4 ships a maintained
   free/personal-provider denylist (gmail/yahoo/outlook/hotmail/icloud/aol/proton/…) — non-denylist domain ⇒ org
   domain ⇒ auto-branch. When spec-297 crowd matching lands (W6), also treat "domain matches a crowd-KB church/org"
   as a positive org-domain signal. (Closes spec 298 §8.3.)
4. **Approver authority custody → RESOLVED: per-operator connection-custody signer (SIWE or KMS), not a passkey
   ceremony.** Per spec 248 (retires the shared-seed C-1) + spec 235 + the "custodian backs all authority" mandate
   (spec 294): the Global.Church approver signs the `requestHash` approval (spec-253 approved-hash) with a signer
   obtained from the operator's session. Console prompt cost: **1 signature** for a SIWE operator (demo personas use a
   one-click long-lived SIWE session — low friction), **0** for a KMS-backed operator. **Security still owns the
   production custody sign-off** (which of SIWE/KMS for the real Global.Church group SA) — flagged, not blocking the
   demo. (Refines spec 297 §6.)
5. **Org-Email display label → RESOLVED: "Work Email".** User-facing badge label is **"Work Email"** (clearer for a
   church administrator); the `BadgeKind` value stays `'org-email'` in code and `ap:OrgEmailBadgeCredential` in the VC.
6. **Approver console home → RESOLVED: a tab in the demo-gs GCO view for W4.** Extract to a dedicated Global.Church
   console app later only if scope demands it. (Matches spec 297 §6.)

### Still requires an external owner (not a design decision)
- **Security:** production custody for the Global.Church approver SA (SIWE vs KMS) — item 4 above.
- **Product/legal:** whether the org→crowd-org `possibleSameAs` is published publicly at approval (spec 297 §5.3 /
  its own §11.3) — a data-publication call, left for the audit.

## 11. Recommended build order (person first)

1. **Brand + flow switch** (298 W1) — "Impact" sweep + `onboarding.flow`.
2. **Badge substrate** (297 W1) — `packages/badges` (model + gating) + Profile badge.
3. **Social-first connect** (298 W2) — ImpactConnect chooser + person deploy + demo-gs nameless CTA + arrival beat.
4. **Badge wallet + Profile** (298 W3) — wallet states, profile-verify, handle claim.
5. **Org-Email badge** (298 W4) — domain branch, SendGrid OTP (+ rate-limit), return-to-parent, idempotency guard.
6. **Crowd matching** (297 W3) — `matchPeople`/`matchOrgsByDomain` + candidate prompt (+ "is this you?" w/ Not sure).
7. **Request + approval** (297 W4) — `packages/approvals`, review-before-submit, approver console, email templates,
   approved-hash deploy gate.
8. **Deploy-on-approval org-create** (297 W5) — associate/create-new → request → approve → org SA + name + Org badge +
   vault claims + public recognition.

Steps 1–5 deliver the complete **person** experience (the part to audit/UX-design first); 6–8 add **organization**.
```
