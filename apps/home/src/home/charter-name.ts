// A NEW agent's name, bought (ap-town spec 431 §5.1). Since the priced roots went live, a name under `.me`, `.org`,
// `.svc`… is not registered by the agent alone: a signed ticket from this Home's gate plus the fee from a treasury,
// in one operation (`PricedSubregistry.claim`). So a charter that asks for a name on a priced ending deploys the
// agent NAMELESS first — the create ceremony as it always was — and then buys the name for it here: the person's
// own treasury pays (the agent is theirs; a treasury born with the agent would hold nothing yet), the new agent
// presents it, and the person's vault link learns the name. The gate's custody check passes because the person's
// credential custodies the new agent — the same key that just deployed it.
import type { Address } from '@agenticprimitives/types';
import { invalidateRelatedOrgs, purchaseName, resolveCredential, typedTldForKind, type AgentKind, type PurchaseRefusal } from '../connect-client';
import { signHashFor, type Via } from './onboarding';
import { ensurePersonTreasury } from './treasury-birthright';
import { NAMING_COIN, isPricedTld } from '../lib/naming-price';

/** Is a name for this kind bought rather than registered? True on a chain whose root for the kind is priced. */
export function kindNameIsBought(kind: AgentKind): boolean {
  const typed = typedTldForKind(kind);
  return !!typed && isPricedTld(typed.tld) && !!NAMING_COIN;
}

export async function buyNameForNewAgent(
  input: { agent: Address; label: string; kind: AgentKind; parent: Address; person: Address; via: string; token: string; email?: string },
  onStep?: (s: string) => void,
): Promise<{ ok: true; name: string; price: number } | PurchaseRefusal> {
  const { agent, label, kind, parent, person, token, email } = input;
  const via = (String(input.via ?? '').toLowerCase() || 'passkey') as Via;
  const typed = typedTldForKind(kind);
  if (!typed || !NAMING_COIN) return { ok: false, error: `no priced ending for ${kind} on this chain` };
  const signPerson = await signHashFor(via, person, { token });
  const treasury = await ensurePersonTreasury({ person, via, token, signPerson }, onStep);
  if (!treasury.ok) return { ok: false, error: `your treasury: ${treasury.error}` };
  const custodian = await resolveCredential(via, null, token).catch(() => null);
  const signPayer = await signHashFor(via, treasury.treasury, { token });
  const signOwner = await signHashFor(via, agent, { token });
  const bought = await purchaseName({
    token, owner: agent, payer: treasury.treasury, label, tld: typed.tld, coin: NAMING_COIN.address,
    ...(email ? { email } : {}), ...(custodian ? { custodian } : {}), signPayer, signOwner,
    ...(typed.serviceRole ? { serviceRole: typed.serviceRole } : {}), ...(onStep ? { onStep } : {}),
  });
  if (!bought.ok) return bought;
  onStep?.('Saving the name…');
  // Only orgName changes; the server MERGES so kind/parent/stewardshipDelegation are preserved.
  const save = await fetch('/connect/related-orgs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ person, orgAgent: agent, orgName: bought.name, kind, parent }),
  });
  invalidateRelatedOrgs();
  if (!save.ok) {
    const e = (await save.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: `${bought.name} is bought and presented, but the vault link was not updated: ${e.error ?? save.status}` };
  }
  return { ok: true, name: bought.name, price: bought.price };
}
