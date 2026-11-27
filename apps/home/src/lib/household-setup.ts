// ONE APP REQUEST: SET UP A HOUSEHOLD (`/household-setup`). A family app collects the household's people and
// preferences itself and writes them to the household's OWN agent; Home's part is the one approval only Home can
// give — create the household agent the person stewards (or find the one this attempt already created), give it its
// planes and the app's household playbook, name it, and renew the person's own storage session, without which the
// household's agent will not confirm them as its steward.
//
// Pure over its dependencies, like `family-onboarding.ts`: the page binds them to the existing ceremonies
// (createAgentWithBirthrights, enableAgentPlanes, assignDefaultArchetype, the org.profile write and projection,
// activateInteractionsIfNeeded for the person). A receipt per ATTEMPT (made once by the app and kept across its
// retries) makes the create idempotent: one attempt never deploys two households, and an uncertain deploy is never
// retried blindly. Completion is told to the app as a navigation hint; the app confirms by reading Home's links.
export const HOUSEHOLD_SETUP_MESSAGE = 'ap-household-setup';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ATTEMPT = /^[a-f0-9]{32}$/;
export const MAX_HOUSEHOLD_NAME = 60;

export interface HouseholdSetupRequest {
  /** The relying app's client id. */
  client: string;
  appName: string;
  /** The household's public name as the person typed it in the app. */
  name: string;
  attempt: string;
  /** A registered redirect URI of the client: where "Done" goes, and the only origin told the outcome. */
  returnTo: string;
  /** An EXISTING household to name and make ready (renew its storage, give it the app's playbook). Absent = create one. */
  household?: string;
  /** The person the app is signed in as, so a Home signed in as someone else is said before anything is signed. */
  member?: string;
}
interface RelyingApp { client_id: string; name?: string; redirect_uris: string[] }

/** The request in the page's address, or why it is refused. Only an app whose defaults found households may ask. */
/** `foundsHouseholds` is `CLIENT_DEFAULTS[client]?.family` at the page (kept out of here so this module stays pure). */
export function householdSetupRequestOf(search: string, apps: RelyingApp[], foundsHouseholds: (client: string) => boolean): { ok: true; request: HouseholdSetupRequest } | { ok: false; error: string } {
  const q = new URLSearchParams(search);
  const client = q.get('from') ?? '', app = apps.find((a) => a.client_id === client);
  const name = (q.get('name') ?? '').trim(), attempt = q.get('attempt') ?? '', returnTo = q.get('return') ?? '';
  const household = q.get('household') ?? '', member = q.get('member') ?? '';
  if (!app || !foundsHouseholds(client)) return { ok: false, error: 'This household request does not come from an app that may set up households.' };
  if (!app.redirect_uris.includes(returnTo)) return { ok: false, error: 'This household request names a return address the app has not registered.' };
  if (!name || name.length > MAX_HOUSEHOLD_NAME) return { ok: false, error: `A household name of 1 to ${MAX_HOUSEHOLD_NAME} characters is required.` };
  if (!ATTEMPT.test(attempt)) return { ok: false, error: 'This household request has no valid attempt id. Start again from the app.' };
  if ((household && !ADDRESS.test(household)) || (member && !ADDRESS.test(member))) return { ok: false, error: 'This household request is invalid. Return to the app and try again.' };
  return {
    ok: true,
    request: { client, appName: app.name ?? client, name, attempt, returnTo, ...(household ? { household: household.toLowerCase() } : {}), ...(member ? { member: member.toLowerCase() } : {}) },
  };
}

export interface HouseholdSetupDependencies {
  /** The person's links, read strictly: a failed read throws and is never "no households". */
  list(): Promise<Array<{ agent: string; kind: string; relationship?: string; status?: string }>>;
  /** Deploy a new household agent the person stewards; resolves with its address. */
  create(name: string): Promise<string>;
  /** Its planes (vault key, delivery grant, interactions grant + session leaf) and the app's household playbook. Idempotent. */
  ready(household: string, opts: { playbook: boolean }): Promise<void>;
  /** Its common name: `org.profile` in its own vault and the projection on the person's link. */
  name(household: string, name: string): Promise<void>;
  /** The PERSON's own storage session (interactions grant + leaf), renewed when lapsed. */
  renewPerson(): Promise<void>;
  receipt: Pick<Storage, 'getItem' | 'setItem'>;
}
export interface HouseholdSetupOutcome { household: string; created: boolean }

const inFlight = new Map<string, Promise<HouseholdSetupOutcome>>();
const stewarded = (links: Awaited<ReturnType<HouseholdSetupDependencies['list']>>, household: string) =>
  links.some((a) => a.kind === 'household' && a.agent.toLowerCase() === household.toLowerCase() && a.relationship === 'steward' && (a.status == null || a.status === 'active'));

export function setUpHousehold(person: string, request: HouseholdSetupRequest, deps: HouseholdSetupDependencies): Promise<HouseholdSetupOutcome> {
  const key = `ap-household-setup:${person.toLowerCase()}:${request.attempt}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const work = async (): Promise<HouseholdSetupOutcome> => {
    if (request.member && request.member !== person.toLowerCase())
      throw new Error('This Home is signed in as a different person from the app. Sign in to the same account in both, then try again. Nothing was created.');
    // AN EXISTING HOUSEHOLD: name it and make it ready. Nothing is created.
    if (request.household) {
      if (!stewarded(await deps.list(), request.household)) throw new Error('Home does not list you as a steward of that household. Nothing was changed.');
      await deps.ready(request.household, { playbook: true });
      await deps.name(request.household, request.name);
      await deps.renewPerson();
      return { household: request.household, created: false };
    }
    // A NEW HOUSEHOLD, at most one per attempt
    const pending = deps.receipt.getItem(key);
    if (pending && ADDRESS.test(pending)) {
      // this attempt already created it: finish what may be unfinished, create nothing
      if (!stewarded(await deps.list(), pending)) throw new Error('This setup already created a household, but its link to you is not confirmed. Repair it at Home; no second household was created.');
      await deps.ready(pending, { playbook: true });
      await deps.name(pending, request.name);
      await deps.renewPerson();
      return { household: pending.toLowerCase(), created: false };
    }
    if (pending) throw new Error('This setup was started but whether it created a household cannot be verified. Check your households at Home before trying again; no second household was created.');
    deps.receipt.setItem(key, 'creation-started');
    const household = await deps.create(request.name);
    if (household.toLowerCase() === person.toLowerCase()) throw new Error('The person and the household must be distinct agents.');
    deps.receipt.setItem(key, household.toLowerCase());
    await deps.ready(household, { playbook: true });
    await deps.name(household, request.name);
    await deps.renewPerson();
    if (!stewarded(await deps.list(), household)) throw new Error('The household was created but your link to it as its steward is not confirmed yet.');
    return { household: household.toLowerCase(), created: true };
  };
  const run = () => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(key, work) : work());
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** Where "Done" goes. A navigation hint only: the app reads its own households to confirm. */
export function householdSetupReturn(returnTo: string, attempt: string): string {
  const url = new URL(returnTo);
  url.searchParams.set('household_setup', attempt);
  return url.href;
}
