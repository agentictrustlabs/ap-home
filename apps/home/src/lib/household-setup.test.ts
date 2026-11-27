import { it, expect, vi, describe } from 'vitest';
import { householdSetupRequestOf, householdSetupReturn, setUpHousehold, type HouseholdSetupDependencies, type HouseholdSetupRequest } from './household-setup';

const APPS = [{ client_id: 'family-field', name: 'Family Field', redirect_uris: ['https://ap-family.faithnet.io/'] }, { client_id: 'pokernight', redirect_uris: ['https://poker.faithnet.io/'] }];
const FAMILY = (c: string) => c === 'family-field';
const ATTEMPT = 'a'.repeat(32), PERSON = '0x' + '1'.repeat(40), OTHER = '0x' + '9'.repeat(40);
const q = (o: Record<string, string>) => '?' + new URLSearchParams(o).toString();

describe('the request', () => {
  const ok = { from: 'family-field', name: 'The Rivera family', attempt: ATTEMPT, return: 'https://ap-family.faithnet.io/' };
  it('is read from the address, with the app named by its registration', () => {
    expect(householdSetupRequestOf(q(ok), APPS, FAMILY)).toEqual({ ok: true, request: { client: 'family-field', appName: 'Family Field', name: 'The Rivera family', attempt: ATTEMPT, returnTo: 'https://ap-family.faithnet.io/' } });
  });
  it('is refused from an app that does not found households, to an unregistered return, or without a name or attempt', () => {
    expect(householdSetupRequestOf(q({ ...ok, from: 'pokernight', return: 'https://poker.faithnet.io/' }), APPS, FAMILY).ok).toBe(false);
    expect(householdSetupRequestOf(q({ ...ok, return: 'https://evil.example/' }), APPS, FAMILY).ok).toBe(false);
    expect(householdSetupRequestOf(q({ ...ok, name: ' ' }), APPS, FAMILY).ok).toBe(false);
    expect(householdSetupRequestOf(q({ ...ok, name: 'x'.repeat(61) }), APPS, FAMILY).ok).toBe(false);
    expect(householdSetupRequestOf(q({ ...ok, attempt: 'nope' }), APPS, FAMILY).ok).toBe(false);
    expect(householdSetupRequestOf(q({ ...ok, household: 'not-an-address' }), APPS, FAMILY).ok).toBe(false);
  });
  it('an existing household and the app’s signed-in person are carried lower-cased', () => {
    const r = householdSetupRequestOf(q({ ...ok, household: '0x' + 'AB'.repeat(20), member: PERSON.toUpperCase().replace('0X', '0x') }), APPS, FAMILY);
    expect(r.ok && r.request.household).toBe('0x' + 'ab'.repeat(20));
    expect(r.ok && r.request.member).toBe(PERSON);
  });
  it('“Done” returns to the registered address with the attempt as a hint', () => {
    expect(householdSetupReturn('https://ap-family.faithnet.io/', ATTEMPT)).toBe(`https://ap-family.faithnet.io/?household_setup=${ATTEMPT}`);
  });
});

function world() {
  const links: Array<{ agent: string; kind: string; relationship: string }> = [], receipts = new Map<string, string>();
  let n = 0;
  const deps: HouseholdSetupDependencies = {
    list: vi.fn(async () => links),
    create: vi.fn(async () => { const a = '0x' + String(++n).padStart(40, '2'); links.push({ agent: a, kind: 'household', relationship: 'steward' }); return a; }),
    ready: vi.fn(async () => {}), name: vi.fn(async () => {}), renewPerson: vi.fn(async () => {}),
    receipt: { getItem: (k) => receipts.get(k) ?? null, setItem: (k, v) => { receipts.set(k, v); } },
  };
  return { deps, links, receipts };
}
const request = (o: Partial<HouseholdSetupRequest> = {}): HouseholdSetupRequest => ({ client: 'family-field', appName: 'Family Field', name: 'The Rivera family', attempt: ATTEMPT, returnTo: 'https://ap-family.faithnet.io/', ...o });

describe('setting up', () => {
  it('creates one named, ready household, renews the person’s storage session, and confirms the steward link', async () => {
    const { deps } = world();
    const out = await setUpHousehold(PERSON, request(), deps);
    expect(out.created).toBe(true);
    expect(deps.create).toHaveBeenCalledWith('The Rivera family');
    expect(deps.ready).toHaveBeenCalledWith(out.household, { playbook: true });
    expect(deps.name).toHaveBeenCalledWith(out.household, 'The Rivera family');
    expect(deps.renewPerson).toHaveBeenCalledOnce();
  });
  it('the same attempt again creates nothing: it finishes the household it already made', async () => {
    const { deps } = world();
    const first = await setUpHousehold(PERSON, request(), deps);
    const again = await setUpHousehold(PERSON, request(), deps);
    expect(deps.create).toHaveBeenCalledOnce();
    expect(again).toEqual({ household: first.household, created: false });
    expect(deps.ready).toHaveBeenCalledTimes(2);
  });
  it('a new attempt is a new household (“set up another household”)', async () => {
    const { deps } = world();
    await setUpHousehold(PERSON, request(), deps);
    await setUpHousehold(PERSON, request({ attempt: 'b'.repeat(32) }), deps);
    expect(deps.create).toHaveBeenCalledTimes(2);
  });
  it('simultaneous approvals of one attempt share one operation', async () => {
    const { deps } = world();
    await Promise.all([setUpHousehold(PERSON, request(), deps), setUpHousehold(PERSON, request(), deps)]);
    expect(deps.create).toHaveBeenCalledOnce();
  });
  it('an uncertain deploy is never retried blindly', async () => {
    const { deps } = world();
    deps.create = vi.fn().mockRejectedValue(new Error('response lost'));
    await expect(setUpHousehold(PERSON, request(), deps)).rejects.toThrow('response lost');
    await expect(setUpHousehold(PERSON, request(), deps)).rejects.toThrow('no second household');
    expect(deps.create).toHaveBeenCalledOnce();
  });
  it('a storage step that failed is retried on the same household', async () => {
    const { deps } = world();
    deps.ready = vi.fn().mockRejectedValueOnce(new Error('grant pending')).mockResolvedValue(undefined);
    await expect(setUpHousehold(PERSON, request(), deps)).rejects.toThrow('grant pending');
    const out = await setUpHousehold(PERSON, request(), deps);
    expect(deps.create).toHaveBeenCalledOnce();
    expect(out.created).toBe(false);
  });
  it('an existing household the person stewards is named and made ready; nothing is created', async () => {
    const { deps, links } = world();
    const h = '0x' + '3'.repeat(40);
    links.push({ agent: h, kind: 'household', relationship: 'steward' });
    expect(await setUpHousehold(PERSON, request({ household: h }), deps)).toEqual({ household: h, created: false });
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.renewPerson).toHaveBeenCalledOnce();
  });
  it('a household the person only belongs to, or does not, is refused before anything is signed', async () => {
    const { deps, links } = world();
    const h = '0x' + '4'.repeat(40);
    links.push({ agent: h, kind: 'household', relationship: 'member' });
    await expect(setUpHousehold(PERSON, request({ household: h }), deps)).rejects.toThrow('steward');
    expect(deps.ready).not.toHaveBeenCalled();
  });
  it('a Home signed in as someone else than the app is said, and nothing is created', async () => {
    const { deps } = world();
    await expect(setUpHousehold(PERSON, request({ member: OTHER }), deps)).rejects.toThrow('different person');
    expect(deps.create).not.toHaveBeenCalled();
  });
  it('a failed read of the person’s links is not “no household”', async () => {
    const { deps } = world();
    const h = '0x' + '5'.repeat(40);
    deps.list = vi.fn().mockRejectedValue(new Error('vault unavailable'));
    await expect(setUpHousehold(PERSON, request({ household: h }), deps)).rejects.toThrow('vault unavailable');
    expect(deps.ready).not.toHaveBeenCalled();
  });
});
