# home

**The Home: where a person, an organization or a service governs its own agent.**

A Next.js app on Vercel, deployed once per estate (faithnet at `www.faithnet.me`, imbnet at `www.impact-agent.me`). The
passkey relying-party id is the Home's own hostname. The Home holds the ceremonies — sign-in, recovery, every
signature a person gives — and hands the agent runtime nothing but what she signed.

## What it does

- **Onboarding and sign-in** by passkey, wallet or Google; a person's Smart Agent with a forced-unique name; the
  Security section (credentials by grade, sessions, recovery with trustees, the vault key, one grants list).
- **The Ask and the buttons**, which reach the same harness boundary; a confirmation that changes anything is the
  mandate signature itself.
- **Organizations, teams, households, treasuries and service agents** chartered under a person; invitations and the
  Join ceremony; roles; playbooks assigned from the skills registry (`org-issuer` for an organization that issues).
- **Messaging, Work, Library, routines, connectors, runs and provenance** — each reading the owner's own records.
- **Naming**: claim, declare the Home's account on a name, and the card studio for released A2A cards.
- **An OIDC broker and FedCM identity provider** for relying apps, which receive scoped delegations and never the
  session key.

White-label content lives in `src/whitelabel/`; the generic substrate underneath is the published `@agenticprimitives/*`
packages.

## Run it

```bash
pnpm --filter @ap-home/home dev        # next dev on http://localhost:5373
pnpm --filter @ap-home/home typecheck && pnpm --filter @ap-home/home test
```

A push to `master` deploys the estate's Vercel project; the Home builds the working tree, so a change ships whole.
