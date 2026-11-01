// "Let <name>.svc read works it is granted" — the Home half: the wire the custodian signs, the admission, the relying-app
// contract (/workspace-read), and the ceremony's order (custody before any signature; on-chain revoke before the clear).
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import { A2A_ANY_SKILL, checkSessionWireShape, skillSelector } from '@agenticprimitives/a2a';
import { CHAIN_ID, CONTRACTS } from '../lib/chain';
import { issueOrgConsultRoutingDelegation, issueServiceLibraryReadWire, LIBRARY_GRANTED_READ_SKILL, SERVICE_READ_WIRE_VALIDITY_SECONDS, type DelegationWire } from '../lib/delegation';
import { parseWorkspaceReadRequest, workspaceReadAdmission, workspaceReadRefusal, workspaceReadReturnUrl } from '../lib/workspace-read-ceremony';
import { enableWorkspaceReadWire, revokeWorkspaceReadWire, type WorkspaceReadDeps } from './workspace-read-wire';

const CUSTODIAN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const SVC = privateKeyToAccount(CUSTODIAN_PK).address.toLowerCase() as `0x${string}`; // stands in for the .svc SA
const SESSION_KEY = '0x7777777777777777777777777777777777777777' as const;
const signer = async (h: Hex) => sign({ hash: h, privateKey: CUSTODIAN_PK, to: 'hex' });
const enforcers = { timestamp: CONTRACTS.timestampEnforcer, allowedMethods: CONTRACTS.allowedMethodsEnforcer };
const methodsOf = (d: Delegation) => (decodeAbiParameters([{ type: 'bytes4[]' }], d.caveats[2]!.terms)[0] as readonly string[]).map((s) => s.toLowerCase());
const now = () => Math.floor(Date.now() / 1000);

describe('issueServiceLibraryReadWire — the wire the custodian signs', () => {
  it('passes checkSessionWireShape for library.granted.read (the identical check at every A2A gate)', async () => {
    const d = await issueServiceLibraryReadWire(SVC, SESSION_KEY, signer);
    expect(checkSessionWireShape({ ...d, salt: d.salt.toString() } as never, enforcers, now(), { skill: LIBRARY_GRANTED_READ_SKILL })).toBeNull();
  });

  it('names exactly ONE method, never the any-skill sentinel; delegator = the service, delegate = the session key, targets = [the service]', async () => {
    const d = await issueServiceLibraryReadWire(SVC, SESSION_KEY, signer);
    expect(methodsOf(d)).toEqual([skillSelector(LIBRARY_GRANTED_READ_SKILL).toLowerCase()]);
    expect(methodsOf(d)).not.toContain(A2A_ANY_SKILL.toLowerCase());
    expect(d.delegator).toBe(SVC);
    expect(d.delegate).toBe(SESSION_KEY);
    expect((decodeAbiParameters([{ type: 'address[]' }], d.caveats[1]!.terms)[0] as readonly string[]).map((t) => t.toLowerCase())).toEqual([SVC]);
    const ts = decodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }], d.caveats[0]!.terms);
    expect(Number(ts[1]) - now()).toBeGreaterThan(SERVICE_READ_WIRE_VALIDITY_SECONDS - 60);
  });

  it('is signed by the CUSTODIAN over the EIP-712 delegation digest — what the service SA\'s ERC-1271 checks (never session-wrapped)', async () => {
    const d = await issueServiceLibraryReadWire(SVC, SESSION_KEY, signer);
    expect(d.signature.startsWith('0x51')).toBe(false);
    const digest = hashDelegation({ ...d, signature: '0x' }, CHAIN_ID, CONTRACTS.delegationManager);
    expect((await recoverAddress({ hash: digest, signature: d.signature })).toLowerCase()).toBe(SVC);
  });

  it('the org routing wire is unchanged — consult first, then the archetype methods, same construction', async () => {
    const d = await issueOrgConsultRoutingDelegation(SVC, SESSION_KEY, signer, undefined, ['ontologist']);
    expect(methodsOf(d)).toEqual([skillSelector('discussion.consult').toLowerCase(), skillSelector('archetype.ontologist').toLowerCase()]);
    expect(checkSessionWireShape({ ...d, salt: d.salt.toString() } as never, enforcers, now(), { skill: 'discussion.consult' })).toBeNull();
    expect(checkSessionWireShape({ ...d, salt: d.salt.toString() } as never, enforcers, now(), { skill: LIBRARY_GRANTED_READ_SKILL })).toMatch(/does not name the library\.granted\.read selector/);
  });
});

describe('/workspace-read — the relying-app contract', () => {
  const client = { client_id: 'source-publishing', name: 'Source Publishing', redirect_uris: ['https://publishing.faithnet.io/home-return'] };
  const href = (q: string) => `https://home.example/workspace-read?${q}`;

  it('parses client_id, redirect_uri, state and agent; the gate is /choose-treasury\'s plus an agent address', () => {
    const req = parseWorkspaceReadRequest(href(`client_id=source-publishing&redirect_uri=${encodeURIComponent(client.redirect_uris[0]!)}&state=s1&agent=${SVC.toUpperCase().replace('0X', '0x')}`));
    expect(req).toEqual({ clientId: 'source-publishing', redirectUri: client.redirect_uris[0], state: 's1', agent: SVC });
    expect(workspaceReadRefusal(req, client)).toBeNull();
    expect(workspaceReadRefusal(req, null)?.check).toBe('client_id');
    expect(workspaceReadRefusal({ ...req!, redirectUri: 'https://publishing.faithnet.io/elsewhere' }, client)?.check).toBe('redirect_uri');
    expect(workspaceReadRefusal({ ...req!, agent: 'ruth.svc' }, client)?.check).toBe('agent');
    expect(workspaceReadRefusal(parseWorkspaceReadRequest(href('agent=0x1')), client)?.check).toBe('params');
  });

  it('answers on the registered redirect_uri, state echoed', () => {
    const ok = new URL(workspaceReadReturnUrl(client.redirect_uris[0]!, 's1', SVC, { hash: '0xabc' }));
    expect(Object.fromEntries(ok.searchParams)).toEqual({ read_wire: 'enabled', read_wire_hash: '0xabc', agent: SVC, state: 's1' });
    const no = new URL(workspaceReadReturnUrl(client.redirect_uris[0]!, 's1', SVC, { error: 'not_custodian' }));
    expect(Object.fromEntries(no.searchParams)).toEqual({ read_wire_error: 'not_custodian', agent: SVC, state: 's1' });
  });

  it('admission: a service, and custody — refused in words otherwise', () => {
    expect(workspaceReadAdmission({ agentLabel: 'ruth-study.svc', isService: true, custodian: true })).toEqual({ ok: true });
    expect(workspaceReadAdmission({ agentLabel: 'ruth-study.svc', isService: true, custodian: false })).toMatchObject({ ok: false, error: 'not_custodian', said: expect.stringMatching(/custodied by a different credential than the one you are signed in with/) });
    expect(workspaceReadAdmission({ agentLabel: 'grace.org', isService: false, custodian: true })).toMatchObject({ ok: false, error: 'not_service' });
  });
});

/** A fake agent: the DO's store as the Home sees it through /connect/channels. */
function fakeDeps(o: { custodian?: boolean; storeStatus?: number; storeError?: string } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let stored: DelegationWire | null = null;
  let revokedOnChain = false;
  const deps: WorkspaceReadDeps = {
    async channels(body) {
      calls.push(body);
      if (body.action === 'signingWireStatus') return { status: 200, body: { ok: true, wirePresent: !!stored, sessionKey: SESSION_KEY, ...(stored ? { wire: stored, hash: '0xhash' } : {}) } };
      if (body.action === 'signingWireEnable') {
        if (o.storeStatus) return { status: o.storeStatus, body: { error: o.storeError ?? 'no' } };
        stored = body.delegation as DelegationWire;
        return { status: 200, body: { ok: true, hash: '0xhash', validUntil: 123 } };
      }
      if (body.action === 'signingWireClear') {
        if (!revokedOnChain) return { status: 409, body: { error: 'still live' } };
        stored = null;
        return { status: 200, body: { ok: true, cleared: true } };
      }
      return { status: 400, body: {} };
    },
    canGrantAs: async () => o.custodian ?? true,
    signAs: async () => signer,
    revokeOnChain: async () => { revokedOnChain = true; return { ok: true, txHash: '0xtx' }; },
  };
  return { deps, calls, stored: () => stored };
}

describe('the ceremony, in order', () => {
  it('custodian: mints, signs as the service, and hands the DO the wire to verify and store', async () => {
    const f = fakeDeps();
    const r = await enableWorkspaceReadWire(f.deps, { agent: SVC, agentLabel: 'ruth-study.svc', isService: true });
    expect(r).toEqual({ ok: true, hash: '0xhash', validUntil: 123 });
    expect(f.calls.map((c) => c.action)).toEqual(['signingWireStatus', 'signingWireEnable']);
    expect(f.stored()!.delegator).toBe(SVC);
    expect(checkSessionWireShape(f.stored() as never, enforcers, now(), { skill: LIBRARY_GRANTED_READ_SKILL })).toBeNull();
  });

  it('NON-custodian: refused in words before any signature is asked for, nothing sent', async () => {
    const f = fakeDeps({ custodian: false });
    const r = await enableWorkspaceReadWire(f.deps, { agent: SVC, agentLabel: 'ruth-study.svc', isService: true });
    expect(r).toMatchObject({ ok: false, error: 'not_custodian' });
    expect(f.calls).toEqual([]);
  });

  it('not a service: refused, nothing sent', async () => {
    const f = fakeDeps();
    expect(await enableWorkspaceReadWire(f.deps, { agent: SVC, agentLabel: 'grace.org', isService: false })).toMatchObject({ ok: false, error: 'not_service' });
    expect(f.calls).toEqual([]);
  });

  it('the DO\'s ERC-1271 refusal is reported as not_custodian, in the DO\'s words', async () => {
    const f = fakeDeps({ storeStatus: 403, storeError: `the signing wire's signature does not verify against ${SVC} — only the credential that custodies this service agent can sign it` });
    expect(await enableWorkspaceReadWire(f.deps, { agent: SVC, agentLabel: 'x', isService: true })).toMatchObject({ ok: false, error: 'not_custodian', said: expect.stringMatching(/does not verify against/) });
  });

  it('revoke: on chain FIRST, then the stored copy is cleared', async () => {
    const f = fakeDeps();
    await enableWorkspaceReadWire(f.deps, { agent: SVC, agentLabel: 'x', isService: true });
    expect(await revokeWorkspaceReadWire(f.deps, SVC)).toEqual({ ok: true, txHash: '0xtx' });
    expect(f.stored()).toBeNull();
    expect(f.calls.map((c) => c.action).slice(-2)).toEqual(['signingWireStatus', 'signingWireClear']);
  });
});
