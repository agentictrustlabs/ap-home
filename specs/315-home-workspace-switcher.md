# Spec 315 — Home workspace switcher: person / org / app scoped navigation

**Status:** W1 SHIPPED · **Depends on:** spec 275 (multi-agent management), spec 310 (Home control
plane), spec 234 (white-label site) · **App:** `apps/home`

## Reference: smart-agent patterns to port

Ported from the **impact home / demo-uupg actor-nav model** in `~/verifiable-content-demo`
(`apps/impact/src/components/ContextSwitcher.tsx`, `src/components/nav.ts`, `src/lib/workspace.ts`;
doctrine in `apps/demo-uupg/ACTOR-NAV-MODEL.md`):

1. **The header carries a workspace switcher** (right of the site name). Its trigger shows the
   active workspace + an authority caption ("acting as you" / "acting as custodian"). The menu
   lists Personal FIRST (a first-class peer, never buried), then the workspaces the person is
   responsible for.
2. **The URL carries the context.** Org surfaces live under `/org/<address>/…`; the shell derives
   the active workspace from the pathname — deep links, refresh, and back-button all land in the
   right context with zero hidden state. Switching = navigating.
3. **The left nav is ALWAYS scoped to the selected workspace.** Person workspace keeps today's
   groups (Interactions, What you steward, Your home — including create org/treasury flows); an
   org workspace gets org-scoped items; an app workspace gets the app's grant surface.
4. **Identity never appears in the switcher** — the top-right identity chip answers "who am I";
   the switcher answers "where am I acting".

Divergence from demo-uupg: no role matrix yet — every listed workspace is one the connected
custodian is responsible for (custody/stewardship, per `listManagedAgents` MAM-D7, or an OIDC
grant it issued), so the caption is "custodian"/"connected app" rather than a derived
`(org-type × role)` cell. The role-derivation seam stays open for when membership roles land.

## Model

```
WorkspaceScope = { kind: 'person' }
              | { kind: 'org';     org: Address }   // /org/<address>/<page>
              | { kind: 'service'; agent: Address } // /service/<address>
```

**A workspace is a CUSTODIAL smart agent, grouped by the ADR-0046 classification** (PROV-O's
trichotomy): Person / Organization / Service. Treasury is a service ROLE, not a class — every
service-class agent (treasury today; indexer, relay, data-source, … later) shares the Services
group and the `/service/<sa>` workspace, dispatching on role for its panel. Connected apps are
the opposite: external apps the person granted access TO, with no custodial rights over them —
they are a person-scoped review surface (`/apps` in the person nav), never a workspace.

- **Person** — the connected custodian's own home: all of today's nav, including creating
  organizations, treasuries, data sources (spec 275 flows stay person-scoped).
- **Org** — one of the org SAs the custodian stewards (`listManagedAgents`, kind `org`).
  Nav: Overview (identity + name-it + treasury), Data (vault reads over the stewardship
  delegation), Treasury.
- **Service** — a service-class agent the custodian manages (class derived by
  `agentClassOf(kind)` — app kinds map DOWN to a class, never up). Nav: Overview
  (role panel — treasury: balance, funding, naming, host connections).

**Authority lineage under each service's name.** The switcher renders the custody chain the
agent was spawned under — walked through managed-agent `parent` links back to the person —
so a person's treasury and an org's treasury read differently at a glance:
`you → treasury` vs `you → acme → treasury`. Most service agents will hang off an
organization; the lineage is what makes that visible.

## Enforcement note (mirrors ACTOR-NAV-MODEL §5.6)

The switcher is the UI's honesty layer, not enforcement: server endpoints keep verifying the
session token / delegations on every call. A hand-crafted URL for a workspace the person doesn't
steward renders an empty/denied state, never data.

## Waves

- **W1 (SHIPPED):** `workspace.ts` (URL-derived scope) + `AgentSwitcher` in the topbar +
  scoped `buildNav` + org workspace pages (overview / data / treasury) + treasury workspace page.
  (First cut listed connected apps in the switcher; corrected same-day — apps are non-custodial.)
- **W2 (later):** roles beyond custodian (member/viewer) once membership assertions land in
  Home; org-scoped Messages; default-workspace pin.
