/**
 * The demo people — one roster, managed here.
 *
 * TESTNET ONLY (Base Sepolia). These private keys are in the repository ON PURPOSE, because these
 * are demo identities holding demo data and the friction of a secret store bought nothing: every app
 * that wants them was copying them into its own `.dev.vars` anyway, which is five copies that drift.
 * One file here is easier and no less safe than five gitignored ones.
 *
 * **NEVER FUND THESE ON MAINNET, and never give one authority over anything real.** Anyone who can
 * read this repository can sign as any of them. That is acceptable for a demo movement and is not
 * acceptable for anything else — if a demo person ever needs to hold something that matters, they
 * stop being a demo person first.
 *
 * NOTE THE DIVERGENCE FROM `tests/e2e-sso/demo-user.ts`, which derives its key from a public seed so
 * there is no literal to scan for. That is still the right pattern for a key nobody needs to look
 * up. These are different: they are a fixed cast with on-chain Smart Agents and custodied
 * organizations already deployed against them, so the keys cannot be re-derived — they have to be
 * recorded. `.gitleaks.toml` allowlists this path for exactly that reason.
 *
 * The HOME remains the runtime source: `GET /connect/demo-personas?client_id=<app>` is what an app
 * should read at runtime, and `POST /connect/demo-signin` is how it signs one in. This file is for
 * scripts, seeding and tests that need to SIGN as one of them without going through a browser.
 */

import personas from './personas.json' with { type: 'json' };

export interface DemoOrg {
  /** The organization's Smart Agent. */
  sa: string;
  name: string;
}

export interface DemoPersona {
  /** Display name, as the Home reports it. */
  name: string;
  /** Their Smart Agent on base-sepolia. */
  sa: string;
  /**
   * Organizations they CUSTODY.
   *
   * Custody is not stewardship: it is credential-level control of the org's Smart Agent. Home's
   * vault gate requires a stewardship delegation as well, and these personas do not have one — so
   * `/connect/related-orgs` returns nothing for them and vault surfaces are unreachable until it is
   * minted. See `docs/upstream/mint-demo-stewardship.md` in the engage repo.
   */
  custodies: DemoOrg[];
  /** The custodian EOA's address. */
  eoaAddress?: string;
  /**
   * The custodian EOA's private key.
   *
   * All seven have one. Five came from the app `.dev.vars` files; Nathan's and David's from
   * `uupg/apps/tracker/seed/demo-accounts.json`, which is also where the Accelerate org they share
   * is defined. Optional in the type because a persona added later may not have one yet, and
   * `privateKeyFor` fails loudly rather than returning undefined.
   */
  eoaPrivateKey?: string;
  /** Set when the tracker seed records a different Smart Agent than the Home reports. */
  saPerTracker?: string;
}

export const DEMO_PERSONAS: Readonly<Record<string, DemoPersona>> = personas as Record<string, DemoPersona>;

export type DemoHandle = keyof typeof DEMO_PERSONAS;

/** Handles this file can sign as. Excludes any persona whose key lives only at the Home. */
export const SIGNABLE: readonly string[] = Object.entries(DEMO_PERSONAS)
  .filter(([, p]) => Boolean(p.eoaPrivateKey))
  .map(([handle]) => handle);

/**
 * The key for a persona, or a clear failure.
 *
 * Throws rather than returning undefined: a caller that needs to sign cannot proceed without one,
 * and "cannot sign as nathan — his key lives only at the Home" is a far more useful thing to read
 * than a downstream signature error.
 */
export function privateKeyFor(handle: string): string {
  const key = DEMO_PERSONAS[handle]?.eoaPrivateKey;
  if (!key) {
    throw new Error(
      `no local key for demo persona "${handle}" — it lives only at the Home. Signable here: ${SIGNABLE.join(', ')}`,
    );
  }
  return key;
}

/** The personas that custody at least one organization. */
export const ORG_CUSTODIANS = Object.entries(DEMO_PERSONAS)
  .filter(([, p]) => p.custodies.length > 0)
  .map(([handle, p]) => ({ handle, ...p }));
