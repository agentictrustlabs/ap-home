/**
 * The organization an org-create attempt already deployed, kept across a retry.
 *
 * An org-create is a chain of steps — deploy, bind the vault, seed records, mint the app's grants, hand the
 * code back — and a failure after the deploy left the organization standing while the error screen's "Try
 * again" (a reload) and the relying app's own retry both started over and deployed a SECOND one under the same
 * name (Gather27, 2026-10-16). The deployed org is remembered here, per app + requested name + person, and the
 * retry connects it as an EXISTING organization instead: one approval, no second deploy. Remembered only once
 * the vault is bound (the one step a reuse cannot redo), and forgotten when the grant is handed back or after
 * TTL_MS — a stale entry would quietly bind a later, unrelated request to an old organization.
 */

export interface DeployedOrgKey {
  /** The relying app's client_id. */
  readonly app: string;
  /** The name the app asked for (`org_base`), as it arrived. */
  readonly orgBase: string;
  /** The person at the ceremony — another person on the same browser must not inherit it. */
  readonly person: string;
}

export interface DeployedOrg {
  readonly orgAgent: string;
  readonly orgName: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEPLOYED_ORG_TTL_MS = 2 * 60 * 60 * 1000;

const keyOf = (k: DeployedOrgKey): string => `ap_org_deployed:${k.app}:${k.orgBase.trim().toLowerCase()}`;

export function rememberDeployedOrg(store: StorageLike, key: DeployedOrgKey, org: DeployedOrg, now = Date.now()): void {
  try {
    store.setItem(keyOf(key), JSON.stringify({ ...org, person: key.person.toLowerCase(), at: now }));
  } catch {
    /* storage blocked — the retry deploys again, as before */
  }
}

/** The organization a recent attempt deployed for this app, name and person — or null. */
export function recallDeployedOrg(store: StorageLike, key: DeployedOrgKey, now = Date.now()): DeployedOrg | null {
  try {
    const raw = store.getItem(keyOf(key));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<DeployedOrg & { person: string; at: number }>;
    if (!v.orgAgent || !/^0x[0-9a-fA-F]{40}$/.test(v.orgAgent)) return null;
    if ((v.person ?? '') !== key.person.toLowerCase()) return null;
    if (typeof v.at !== 'number' || now - v.at > DEPLOYED_ORG_TTL_MS) {
      store.removeItem(keyOf(key));
      return null;
    }
    return { orgAgent: v.orgAgent, orgName: v.orgName ?? key.orgBase };
  } catch {
    return null;
  }
}

export function forgetDeployedOrg(store: StorageLike, key: DeployedOrgKey): void {
  try {
    store.removeItem(keyOf(key));
  } catch {
    /* nothing to forget */
  }
}
