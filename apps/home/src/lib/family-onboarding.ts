/** Coordinates existing Home ceremonies. A receipt prevents blind retries after an uncertain deploy;
 * it is not membership, authority, or a second family datastore. Canonical links are always read first. */
export interface FamilySetupDependencies {
  list(): Promise<Array<{agent: string; kind: string; relationship?: string; status?: string}>>;
  treasury(): Promise<void>;
  create(): Promise<string>;
  ready(agent: string): Promise<void>;
  receipt: Pick<Storage, 'getItem'|'setItem'|'removeItem'>;
}
const inFlight = new Map<string, Promise<void>>();
export function ensureFamilyOnboarding(person: string, founder: boolean, deps: FamilySetupDependencies): Promise<void> {
  const key = `${person.toLowerCase()}:${founder ? 'founder' : 'join'}`;
  const existing = inFlight.get(key); if (existing) return existing;
  const work = async () => {
    // Read failure is not "none". A treasury must not be duplicated during a temporary vault outage.
    let links = await deps.list();
    if (!links.some(a => a.kind === 'person-treasury' && a.relationship === 'steward')) await deps.treasury();
    if (!founder) return;
    const marker = `ap-family-setup:${person.toLowerCase()}`;
    const pending = deps.receipt.getItem(marker);
    links = await deps.list();
    const families = links.filter(a => a.kind === 'household' && ['member', 'steward'].includes(a.relationship ?? ''));
    if (families.length) {
      // Existing family: preserve its chosen playbook. Only repair one created by this unfinished ceremony.
      const unfinished = families.find(a => a.agent.toLowerCase() === pending?.toLowerCase());
      if (unfinished) { await deps.ready(unfinished.agent); deps.receipt.removeItem(marker); }
      return;
    }
    if (pending) throw new Error('A family setup was started but its completion cannot be verified. Repair its link at Home before retrying; no second household was created.');
    deps.receipt.setItem(marker, 'creation-started');
    const household = await deps.create();
    if (household.toLowerCase() === person.toLowerCase()) throw new Error('The person and household must be distinct agents.');
    deps.receipt.setItem(marker, household);
    await deps.ready(household);
    const confirmed = (await deps.list()).some(a => a.kind === 'household' && a.agent.toLowerCase() === household.toLowerCase() && a.relationship === 'steward');
    if (!confirmed) throw new Error('The family was created but its private vault link is not confirmed.');
    deps.receipt.removeItem(marker);
  };
  const run = () => typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(`ap-family-setup:${person.toLowerCase()}`, work)
    : work();
  const promise = run().finally(() => inFlight.delete(key));inFlight.set(key,promise);return promise;
}
