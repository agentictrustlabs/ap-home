# Impact Community Portal — Greenfield UX Design
### Spec 234 W2 Experience Layer · Faith vertical · 2026-05-28

> Architecture-of-record: [`specs/234-white-label-agentic-trust-site.md`](../../../specs/234-white-label-agentic-trust-site.md) (§11).
> This document is the **greenfield** realization of the Experience Layer — a from-scratch
> portal experience, not a re-theme of the prior auth-tool screens. Copy/brand is white-label
> config (`src/whitelabel/`); structure is generic.

---

## 1. Design Principles + Voice/Tone

1. **Your home, not our tool.** The portal is the member's own property — their canonical
   identity address, their on-chain agent, their subdomain. Every surface reinforces
   possession ("your portal," "you own this"). Present it as a home they inhabit, never a
   service they access.
2. **Belonging before mechanics.** Lead with the human meaning of each action (you are known
   in this community; your giving is stewarded well) before the mechanism. Crypto vocabulary
   is a tooltip, never a headline.
3. **Control made visible.** The member sees, at a glance, who has access and what they can
   do. Connected apps, granted permissions, devices — all surfaced plainly. Revocation is
   never buried.
4. **Fewest moments of effort, most moments of meaning.** Technical minimalism (batched ops,
   one confirmation per distinct consent boundary) + experiential richness (celebratory
   receipts, milestone markers, warm copy). Never add friction that serves the system.
5. **Trust is earned incrementally.** The portal grows with the member. "Coming soon" areas
   are real destinations, not dead ends.
6. **Accessible by default.** WCAG 2.2 AA, reduced-motion path for every animation, visible
   focus, 44×44px touch targets, screen-reader copy that reads naturally.

**Voice/Tone:** warm, direct, unhurried — a trusted guide in a community you already belong
to. Short, concrete sentences; verbs lead. Faith vocabulary (stewardship, community,
belonging) is permitted in copy config; theological/denominational specificity stays out of
the generic layer.

---

## 2. Visual Direction

### 2.1 Palette — Warm Civic Light
The current app uses a cool indigo/slate palette suited to an auth tool. The Impact portal
extends the light foundation toward warmth and organic trust.

```
Core
--color-surface          #FFFFFF   page background
--color-surface-raised   #FAFAF8   cards, panels
--color-surface-sunken   #F5F3EF   inset areas, sidebars
--color-border           #E8E4DC   dividers
--color-border-strong    #D1CBC0   emphasized dividers

Amber (primary brand accent — warmth, energy, community)
--color-amber-50 #FFFBEB  -100 #FEF3C7  -400 #FBBF24
--color-amber-500 #F59E0B (primary)  -600 #D97706 (hover)  -700 #B45309 (pressed)

Sage (trust, stewardship, growth — status/receipts)
--color-sage-50 #F0FDF4  -100 #DCFCE7  -500 #22C55E  -700 #15803D (text on sage-50)

Stone (neutrals — text hierarchy)
--color-text-primary #1C1917  -body #44403C  -muted #78716C  -faint #A8A29E

Semantic
--color-action #F59E0B  --color-action-fg #1C1917 (9.5:1 on amber, AAA)
--color-focus #0EA5E9 (universal, brand-independent)
--color-danger #DC2626  --color-danger-subtle #FEF2F2
```
Dark mode: out of scope; the palette meets contrast on all surfaces without it.

### 2.2 Typography
```
Inter, system-ui, -apple-system, sans-serif  (config may override via --font-brand)
display-xl 36/1.15/700  portal welcome      title-md 18/1.4/600  panel headings
display-lg 28/1.2/700   section titles       body-lg  16/1.6/400  primary reading
title-lg   22/1.3/600   card titles, steps   body-md  14/1.5/400  secondary
label-lg   13/1.4/500   badges/chips         label-sm 11/1.3/500  timestamps
mono       13/1.5/400   addresses — JetBrains Mono / Fira Code
```

### 2.3 Shape + Space
Radius: 4 (inputs), 8 (chips), 12 (cards), 16 (panels/modals), 24 (large ceremony cards).
4px spacing grid; insets 16 (mobile) / 24 (desktop). Card shadow
`0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.05)`; modal `0 4px 12px rgba(0,0,0,.1)`.

### 2.4 Iconography (Lucide React)
You `User` · Organization `Building2` · Treasury `Landmark`/`Wallet` · Data `Database` ·
Apps `Link2` · Security `ShieldCheck` · Activity `History` · Success `CheckCircle2` (sage) ·
Revoke `Unlink` · Coming-soon `Lock` (muted).

### 2.5 Motion
`150ms ease-out` UI state; `250ms ease-in-out` panel entrance; `400ms spring` celebration
receipts. `prefers-reduced-motion: reduce` collapses springs/slides to instant; the receipt
checkmark draw becomes an immediate icon show.

### 2.6 The Warmth Signal (what distinguishes it from a crypto tool)
1. Brand shield uses the **amber** gradient in the portal (the generic indigo shield stays
   for the external auth ceremony popup).
2. Empty states use warm illustration (SVG; `brand.illustrationStyle: 'organic'|'geometric'|'none'`).
3. Portal header uses `--color-surface-sunken` with an amber-50 tint at 30% — a warm wash
   distinct from the stark white of external sign-in pages.

---

## 3. Information Architecture + Navigation

### 3.1 Portal IA
```
alice.impact-agent.me/
├── [/]               Portal Home (dashboard)
├── /you              Your Person Agent (identity, profile, public name)
├── /organizations    Organizations you govern  [live → soon]
├── /treasuries       Treasuries you steward     [live → soon]
├── /data-sources     Data you share             [live → soon]
├── /apps             Connected apps             [LIVE]
├── /security         Sign-in methods & devices  [LIVE]
└── /activity         Audit log                  [live → soon]
```
The `manageableAgents` config array drives which sections appear and live/soon status.

### 3.2 Navigation — desktop (≥768px): persistent left sidebar (240px)
```
┌──────────────────────────────────────────────────────────┐
│  [Shield] Impact                     alice.demo.agent [▾] │  topbar 56px
├───────────┬──────────────────────────────────────────────┤
│  You      │                                              │
│  ── YOUR AGENTS ──                                       │
│  Organizations                                           │
│  Treasuries                                              │
│  Data Sources                                            │
│  ── PORTAL ──                                            │
│  Connected Apps   •      │           main content        │
│  Security                │                               │
│  Activity                │                               │
└───────────┴──────────────────────────────────────────────┘
```
Active item: amber left border (3px) + amber-50 bg + amber-700 text. Group headings 11px
muted uppercase. The `•` on Connected Apps is a sage notification badge on new grants.

**Mobile (<768px): bottom tab bar (Home · You · Orgs · Apps · More) + hamburger drawer**
for the full tree (Treasuries, Data Sources, Activity).

### 3.3 Identity chip (topbar right) popover
```
┌──────────────────────────────────┐
│ alice.demo.agent                 │
│ 0x1234…abcd   [Copy]             │
│ ─────────────────────────────── │
│ View your portal                 │
│ Sign out                         │
└──────────────────────────────────┘
```

---

## 4. The Onboarding First-Run Journey

### 4.1 Entry points
- **A — App-initiated** (Faith App): member types name in the Faith App → not registered →
  redirect to `alice.impact-agent.me`.
- **B — Self-serve**: visits apex / their subdomain directly. No relying app; step 3 skipped.
- **C — Return / enrolled**: name resolves. This device has the passkey → one-touch "Continue
  as alice.demo.agent"; otherwise the "Add this device" path (§4.7).

### 4.2 Sequence (app-initiated)
`1 ARRIVAL → 2 OVERVIEW → 3 SETUP (1+2: promise→prompt→receipt ①②) → 4 GRANT (③) → 5 LANDING`

### 4.3 Screen 1 — Arrival
```
            [Brand shield, 64px, amber]   Impact
   ┌──────────────────────────────────────────┐
   │  Welcome to your                          │
   │  Impact community portal                  │
   │  This is your own secure home in the      │
   │  Impact community — you own it, you        │
   │  control it.                              │
   │  You chose the name:                      │
   │   ┌──────────────────────────────────┐   │
   │   │  alice                           │   │
   │   │  alice.demo.agent                │   │
   │   └──────────────────────────────────┘   │
   │   [  Get started  ]                       │
   └──────────────────────────────────────────┘
              Already a member?  Sign in
```
Copy from config (`arrivalTitle`, `arrivalBody`). **Self-serve variant:** the name chip
becomes a live-validated name input ("Choose your name in the {community}"). States: loading,
name-taken (re-focus input).

### 4.4 Screen 2 — Overview
```
   ┌──────────────────────────────────────────┐
   │  Here's what you're setting up            │
   │  ① Your own Portal               ○        │
   │    A Smart Agent that is yours — your      │
   │    private command center. No password.    │
   │  ② Your place in the Impact community  ○  │
   │    A name others can find and trust.       │
   │  ③ Give Faith App access         ○        │
   │    A scoped, revocable permission. You     │
   │    stay in control, revoke anytime.        │
   │  Steps ① and ② happen together —          │
   │  one confirmation, two milestones.         │
   │  [  Set up my Portal  ]                    │
   └──────────────────────────────────────────┘
```
Steps are a **list of value milestones** (circles fill on completion), not a wizard progress
bar. The "one confirmation, two milestones" note is always shown — it preempts confusion.
Step ③ only renders with a relying-app context; self-serve replaces it with "Apps you
authorize later."

### 4.5 Screen 3 — Setup ceremony (steps 1+2): promise → in-progress → receipts
**3a Promise** sets the expectation explicitly: *"You'll see ONE confirmation from your
device."* CTA `Set up my Portal`.
**3b In-progress** — amber progress ring + two milestone circles that fill sequentially as
the batched op confirms (Portal deployed → "Your Portal is live"; name registered → "You're
alice in the Impact community"). "This takes about 10 seconds. Stay on this page."
**3c Receipts** — two sage receipt cards slide in with a 150ms stagger:
```
   Your portal is ready
   ┌──────────────────────────────────┐
   │ [✓] Your Portal is live           │
   │     Deployed on Base Sepolia      │
   │     0x1234…abcd     [↗]           │
   └──────────────────────────────────┘
   ┌──────────────────────────────────┐
   │ [✓] You're alice in the           │
   │     Impact community              │
   │     alice.demo.agent              │
   └──────────────────────────────────┘
   [  Continue  ]
```

### 4.6 Screen 4 — App grant consent (step 3, app-initiated only)
A deliberate, SEPARATE consent (never batched with setup). App identity (logo + **domain**)
shown BEFORE the permission list. Mandatory **can / cannot** lists + expiry + "revoke anytime
from Connected Apps." "Not now" is always available.
```
   One more step
   ┌──────────────────────────────────┐
   │ [logo]  Faith App                 │
   │         faithapp.example          │
   └──────────────────────────────────┘
   Give Faith App access
   ✓ Sign in as you in the community
   ✓ Help you create organizations
   ✓ Read your community profile
   ✗ It cannot move your funds
   ✗ It cannot add new sign-in methods
   ✗ It cannot change your recovery
   Permission expires: 90 days
   You can revoke this anytime from Connected Apps.
   [  Authorize Faith App  ]   [  Not now  ]
```
Receipt → auto-redirect in 2s (manual "Continue to Faith App" fallback after 1s). "Not now" →
portal home with the pending-auth surface highlighted.

### 4.7 Returning member + new device
```
   Welcome back, alice.demo.agent
   This device isn't connected to your portal yet.
   [  Add this device  ]
   [  Sign in on my other device  ]   (QR/deep-link)
   ── or ──   [  Sign in another way  ]  (wallet)
```

### 4.8 Screen 5 — Celebratory landing (into the portal home)
First load shows a welcome banner ("Welcome to your Impact portal, alice / You're all set.
This is your home.") that fades after 6s or on navigation, then the permanent portal home.
Return visits: "Good to see you."

---

## 5. Portal Home + Section Designs

### 5.1 Portal Home (dashboard) — a map of the member's portal (not a feed)
```
── YOU ──
[icon] alice.demo.agent · 0x1234…abcd [Copy] · Base Sepolia · Live   [View your agent →]

── AGENTS YOU MANAGE ──
┌Organizations┐ ┌Treasuries┐ ┌Data Sources┐
│Ministries,  │ │Funds and │ │Records you │
│churches…    │ │giving…   │ │can share…  │
│[Lock] Soon  │ │[Lock]Soon│ │[Lock] Soon │
└─────────────┘ └──────────┘ └────────────┘

── PORTAL MANAGEMENT ──
[Link2] Connected Apps (1)  [Manage →]   [ShieldCheck] Security (2)  [Manage →]
[History] Activity — Audit log (coming soon)
```

### 5.2 "You" (person agent) — hero identity card (name, address, explorer link, member-since)
+ identity facts + a "Your profile (coming soon)" block.

### 5.3 Organizations / Treasuries / Data Sources (coming soon) — identical `<SectionShell>`
+ `<ComingSoonState>`: muted icon, honest "what will be here" body, and (orgs only) a
"Go to Faith App →" link when a relying app with `org-create` is configured.

### 5.4 Connected Apps (LIVE)
Active app cards with can/cannot lists, granted/expiry dates, and **Revoke access** →
**inline confirm** (not a browser dialog/modal). Revoked apps move to a REVOKED section with
a receipt chip + "Re-authorize." Empty state explains apps will appear + always revocable.

### 5.5 Security & Recovery (LIVE)
Sign-in methods (passkeys) + linked devices (add/link/unlink) + a "Recovery (trustees /
guardians) — coming soon" block. "Remove" is destructive (inline confirm) and hidden when it
would leave zero credentials ("This is your only sign-in method…").

### 5.6 Activity (coming soon) — "a trustworthy record of what your portal + connected apps
have done on your behalf."

---

## 6. Component Inventory
`<AgentIdentityCard>` (hero|standard|compact; live|soon; loading/error states) ·
`<ValueStepList>` (onboarding milestones, circles fill on complete) ·
`<OnboardingProgress>` (dot indicator, aria-live) · `<ReceiptCard>` (sage, checkmark draw) ·
`<ConsentSheet>` (app grant; **throws in dev if `cannotDo` empty**) · `<SectionShell>`
(heading + responsive width; renders `<ComingSoonState>` when status='soon') ·
`<ComingSoonState>` (honest promise, never bare "coming soon") · `<ConnectedAppCard>`
(active→revoking→revoked) · `<DeviceRow>` · `<InlineConfirm>` (replaces confirm()/modal for
contained destructive actions) · `<AddressChip>` (copy w/ feedback) · `<PortalTopbar>` ·
`<PortalSidebar>` / `<PortalBottomNav>` (coming-soon items navigable via `aria-disabled`, not
`disabled`).

---

## 7. White-Label Config Mapping
**Config-driven (per vertical):** brand name/community/logo/tagline; all onboarding copy
(`copy.*`); section blurbs + live/soon (`manageableAgents`); credential methods; enabled
services; relying apps; consent can/cannot + expiry.
**Generic (structural):** nav model; component APIs + state machines; device-prompt
sequencing/batch rules; a11y behavior; the can/cannot consent pattern; the coming-soon
pattern; revoke mechanics.

**Schema additions needed** (do before wiring consent):
```ts
// schema.ts — WhiteLabelConfig
delegationTemplates: Record<string, {
  canDo: string[];
  cannotDo: string[];   // required — ≥3 items; <ConsentSheet> enforces presence
  expiryDays?: number;  // drives "Permission expires: N days"
}>;
// RelyingApp
logo?: string;          // app logo for consent comes from REGISTERED config, never a request param (anti-spoof)
```
Example: `site-login` → canDo ["Sign in as you in the community","Read your community
profile"], cannotDo ["Move funds","Add sign-in methods","Change your recovery"], expiryDays 90.

---

## 8. Accessibility
Contrast ≥4.5:1 body / ≥3:1 large (action-fg on amber = 9.5:1). Universal `#0EA5E9` focus
ring (2px, 2px offset). Sidebar `<nav aria-label>`; nav items are `<a>`; coming-soon =
`<a aria-disabled="true">` (navigable, not removed from tab order). 44×44px targets.
`<OnboardingProgress>` `aria-live="polite"`; receipts `role="status"`. Reduced-motion
collapses animation. Onboarding steps are `<ol>`; can/cannot are `<ul>` with descriptive
accessible names. Inline errors via `aria-describedby`, never toast-only.

---

## 9. Edge Cases + Risks
- **Setup network failure / >30s**: idempotent recovery ("don't refresh; check status →"
  explorer link); on retry check whether deploy already succeeded before resubmitting.
- **Name taken between overview and confirm**: register reverts → back to Arrival, "alice was
  just claimed — choose another," input pre-focused.
- **Passkey create cancelled**: return to Promise, "your confirmation was cancelled — try
  again?"; no state lost.
- **App grant "Not now"**: portal fully functional; pending auth surfaced on first home load.
- **Delegation expires in-portal**: Connected Apps shows expired state + "Re-authorize."
- **Unlink last device**: blocked with explanation.
- **On-chain revoke fails**: inline error, confirm buttons restored; never show "revoked"
  without a submitted revoke.
- **Unregistered/phishing app**: only registered `relyingApps` can present consent; an
  unregistered authorization attempt hard-errors BEFORE any consent UI ("not registered with
  your portal — do not authorize").

---

## 10. Open Questions (need PM / Security / Dev input)
1. `delegationTemplates` resolver: server-side lookup (auditable) vs client-side from config? (Security)
2. Activity scope: person SA only, or governed orgs too? (IA / data placement)
3. Coming-soon card click → navigate to section (current design) vs inline tooltip? (PM)
4. Consent app logo MUST come from registered config, not a request param (anti-spoof) — add
   `RelyingApp.logo`. (Security)
5. "Member since" date — indexer vs on-chain event (ADR-0012 no eth_getLogs)? (Dev)
6. Self-serve first domain: apex vs shared invite to subdomain? (PM)

---

## 11. Developer Handoff
- Portal shell (`<PortalSidebar>`, `<PortalTopbar>`, `<SectionShell>`) = Server Components;
  only on-chain/interactive sections (Connected Apps, Security) are `'use client'`.
- Components receive copy as PROPS resolved from `whitelabel` by the Experience Layer — no
  component imports `whitelabel` directly (testable without a vertical config).
- Add `delegationTemplates` (+ `RelyingApp.logo`) to schema/config before wiring consent.
- Setup receipts shown AFTER tx confirmation (parse events for both ops), in order.
- `<InlineConfirm>` replaces `confirm()`/modals for contained destructive actions
  (grid-template-rows 0fr→1fr expand).
- `<AddressChip>` uses Clipboard API + `execCommand` fallback; "Copied" clears after 2s.
- **Revoke is custody-grade**: `revokeDelegationByOwner` needs the ROOT passkey; a login-grade
  session must step-up first. Do not call it from a login-grade session. (Confirm exact
  session-grade check with Security.)
- Coming-soon nav items route to the section's `<ComingSoonState>` (not `disabled`).
