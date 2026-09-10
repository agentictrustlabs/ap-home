// Spec 350 W2 scenario 2 — `organization.team.create` does what the Home's button does, conversationally:
// asks for what it lacks, derives the genesis from the ask, checks what came back signed IS what it derived,
// and only then submits. The substrate is faked; the protocol is what is under test.
import { describe, expect, it, vi } from 'vitest';
import { buildCaveat, encodeTimestampTerms, intentDigest, type Delegation } from '@agenticprimitives/delegation';
import { isInputRequired, type InvokeContext, type MandatePresentation } from '@agenticprimitives/orchestration';
import { childAgentCreateInvoker, inviteInvoker, askReplyFor, fundingAmount, scopedActionTools, UNSUPPORTED_TOOL, CAPABILITY_CEREMONIES, surfaceCanRender, type TeamGenesisDeps, type HarnessEnv, type GenesisUserOpJson } from '../src/harness-run.js';

const env: HarnessEnv = {
  CHAIN_ID: '34348', DELEGATION_MANAGER: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7',
  TIMESTAMP_ENFORCER: '0xBb8fF9c82417189c6EfeBbB369e9dd9d651aa0f3', VALUE_ENFORCER: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975',
  ALLOWED_TARGETS_ENFORCER: '0xb06252FaD1D41B9943c73ec696Af70F268581625', ALLOWED_METHODS_ENFORCER: '0xa076b759D6785bA5E67016e399Af651fC2ABC811',
  DIGEST_BINDING_ENFORCER: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
};
const WORKSPACE = '0x3d653cbab0c99b1513439758eb2eac2039caa6e1';
const HARNESS = '0xd34c3fbc89706dd57d426546dcebd3ba926ede35';
const PERSON = '0x1111111111111111111111111111111111111111';
const EOA = '0x2222222222222222222222222222222222222222';
const CHILD = '0x3333333333333333333333333333333333333333';
const VALID_AFTER = 1_800_000_000;

const wire: Delegation = {
  delegator: WORKSPACE, delegate: HARNESS, authority: `0x${'f'.repeat(64)}`,
  caveats: [buildCaveat(env.TIMESTAMP_ENFORCER as `0x${string}`, encodeTimestampTerms(VALID_AFTER, VALID_AFTER + 3600))],
  salt: 1n, signature: '0x',
};
const presented: MandatePresentation = { ref: '0xmandate', wire };
const intent = { goal: 'add a new team xyz to this workspace', context: { parent: WORKSPACE } };
const ctxWith = (supplied?: InvokeContext['supplied']): InvokeContext => ({ intent, step: { toolId: 'organization.team.create', args: {} }, index: 0, ...(supplied ? { supplied } : {}) });

function fakeGenesis(over: Partial<TeamGenesisDeps> = {}) {
  const built: unknown[] = [];
  const submitted: GenesisUserOpJson[] = [];
  const op = (salt: bigint, label: string): GenesisUserOpJson => ({ sender: CHILD, nonce: '0', initCode: `0xinit${salt.toString(16).slice(0, 8)}`, callData: `0xcall${label}`, accountGasLimits: '0x00', preVerificationGas: '1', gasFees: '0x00', paymasterAndData: '0xpm-window-A', signature: '0x' });
  const deps: TeamGenesisDeps = {
    isCustodianOf: vi.fn(async (p, c) => p === PERSON && c.kind === 'eoa' && c.address === EOA),
    resolveName: vi.fn(async () => null),
    build: vi.fn(async (i) => { built.push(i); return { child: CHILD, name: `${i.label}.${i.tld}`, userOp: op(i.salt, i.label), userOpHash: `0xhash-${i.label}`, stewardship: { delegator: CHILD, delegate: i.parent, authority: '0x', caveats: [], salt: i.stewardship.salt.toString(), signature: '0x03' } }; }),
    userOpHash: vi.fn(async (u) => `0xhash-${u.callData.replace('0xcall', '')}`),
    isDeployed: vi.fn(async () => false),
    submit: vi.fn(async (u) => { submitted.push(u); return { txHash: '0xtx' }; }),
    ...over,
  };
  return { deps, built, submitted };
}

const run = async (deps: TeamGenesisDeps, args: Record<string, unknown>, supplied?: InvokeContext['supplied'], person: `0x${string}` | undefined = PERSON) => {
  try { return { ok: true as const, result: await childAgentCreateInvoker(deps, env, presented, person)('organization.team.create', args, ctxWith(supplied)) }; }
  catch (e) { return isInputRequired(e) ? { ok: false as const, prompt: e.request } : { ok: false as const, error: (e as Error).message }; }
};

describe('organization.team.create — the conversational ceremony', () => {
  it('asks for the name and the credential when the ask named neither; asks only for what is still missing', async () => {
    const g = fakeGenesis();
    const r1 = await run(g.deps, { parent: WORKSPACE });
    expect(r1.ok).toBe(false);
    expect(r1.prompt?.kind).toBe('data');
    expect(r1.prompt?.kind === 'data' ? r1.prompt.fields.map((f) => `${f.name}:${f.type}`) : []).toEqual(['label:text', 'custodian:credential']);
    const r2 = await run(g.deps, { parent: WORKSPACE, label: 'xyz' });
    expect(r2.prompt?.kind === 'data' ? r2.prompt.fields.map((f) => f.name) : []).toEqual(['custodian']);
    expect(g.deps.build).not.toHaveBeenCalled();
  });

  it('rejects a label the naming rule refuses and says so in the hint', async () => {
    const g = fakeGenesis();
    // Too short even once normalised. "X Y!" is no longer refused: a spoken or typed name becomes its
    // label (`x-y`) — see the next test.
    const r = await run(g.deps, { parent: WORKSPACE, label: 'ab' }, [{ stepRef: 's0', data: { custodian: { kind: 'eoa', address: EOA } } }]);
    expect(r.prompt?.kind === 'data' ? r.prompt.fields[0] : null).toMatchObject({ name: 'label', hint: expect.stringContaining('not a valid team name') });
  });

  it('takes the name as said — "the Outreach Team" is outreach.team (spec 369)', async () => {
    const g = fakeGenesis();
    const r = await run(g.deps, { parent: WORKSPACE, label: 'the Outreach Team' }, [{ stepRef: 's0', data: { custodian: { kind: 'eoa', address: EOA } } }]);
    expect(r.prompt?.kind === 'signature' ? r.prompt.prompt : r).toContain('outreach.team');
  });

  it('asks again with the reason when the name is taken', async () => {
    const g = fakeGenesis({ resolveName: vi.fn(async (n) => (n === 'xyz.team' ? '0x9999999999999999999999999999999999999999' : null)) });
    const r = await run(g.deps, { parent: WORKSPACE, label: 'xyz' }, [{ stepRef: 's0', data: { custodian: { kind: 'eoa', address: EOA } } }]);
    expect(r.prompt?.kind === 'data' ? r.prompt.fields[0]?.hint : '').toContain('xyz.team is already taken');
  });

  it('custody is always the connected user: a credential that does not custody the person is refused', async () => {
    const g = fakeGenesis();
    const r = await run(g.deps, { parent: WORKSPACE, label: 'xyz' }, [{ stepRef: 's0', data: { custodian: { kind: 'eoa', address: '0x9999999999999999999999999999999999999999' } } }]);
    expect(r.ok).toBe(false);
    expect('error' in r ? r.error : '').toContain('custody is always the connected user');
    expect(g.deps.build).not.toHaveBeenCalled();
  });

  it("the workspace is the mandate's delegator — a plan naming another parent fails the step", async () => {
    const g = fakeGenesis();
    const r = await run(g.deps, { parent: PERSON, label: 'xyz' });
    expect('error' in r ? r.error : '').toContain("chartered by the mandate's delegator");
  });

  it('derives the genesis from the ask and asks the connected credential to sign its hash — with the userOp in the open', async () => {
    const g = fakeGenesis();
    const supplied = [{ stepRef: 's0', data: { label: 'xyz', custodian: { kind: 'eoa', address: EOA } } }];
    const r = await run(g.deps, { parent: WORKSPACE }, supplied);
    expect(r.prompt?.kind).toBe('signature');
    const p = r.prompt as Extract<NonNullable<typeof r.prompt>, { kind: 'signature' }>;
    expect(p.signer).toBe(EOA);
    expect(p.digest).toBe('0xhash-xyz');
    expect(p.payload).toMatchObject({ child: CHILD, name: 'xyz.team', parent: WORKSPACE, userOp: { sender: CHILD, callData: '0xcallxyz' } });
    // deterministic from the intent: the same ask derives the same salts and the same stewardship window
    const b = g.built[0] as { salt: bigint; stewardship: { salt: bigint; validUntil: number } };
    const again = await run(g.deps, { parent: WORKSPACE }, supplied);
    expect(again.prompt?.kind).toBe('signature');
    const b2 = g.built[1] as typeof b;
    expect(b2.salt).toBe(b.salt);
    expect(b2.stewardship.salt).toBe(b.stewardship.salt);
    expect(b2.stewardship.validUntil).toBe(VALID_AFTER + 365 * 24 * 3600);
    expect(g.deps.submit).not.toHaveBeenCalled();
  });

  it('on a signed resume: re-derives, checks the signed op IS the derived one, and submits it with the signature', async () => {
    const g = fakeGenesis();
    const supplied = [{ stepRef: 's0', data: { label: 'xyz', custodian: { kind: 'eoa', address: EOA } } }];
    const asked = await run(g.deps, { parent: WORKSPACE }, supplied);
    const p = asked.prompt as Extract<NonNullable<typeof asked.prompt>, { kind: 'signature' }>;
    // the surface's build may differ in the paymaster window — the meaning (sender/initCode/callData) must not
    const signedOp = { ...(p.payload as { userOp: GenesisUserOpJson }).userOp, paymasterAndData: '0xpm-window-B' };
    const r = await run(g.deps, { parent: WORKSPACE }, [...supplied, { stepRef: 's0', signature: { digest: p.digest, signer: EOA, signature: '0xsig', payload: { userOp: signedOp } } }]);
    expect(r.ok).toBe(true);
    expect('result' in r ? r.result : null).toMatchObject({ txHash: '0xtx', agent: CHILD, name: 'xyz.team', kind: 'team', parent: WORKSPACE, custodian: { kind: 'eoa', address: EOA }, person: PERSON });
    expect(g.submitted[0]).toMatchObject({ sender: CHILD, callData: '0xcallxyz', paymasterAndData: '0xpm-window-B', signature: '0xsig' });
  });

  it('refuses a signed op whose meaning differs from what this ask derives (a different callData)', async () => {
    const g = fakeGenesis();
    const supplied = [{ stepRef: 's0', data: { label: 'xyz', custodian: { kind: 'eoa', address: EOA } } }];
    const asked = await run(g.deps, { parent: WORKSPACE }, supplied);
    const p = asked.prompt as Extract<NonNullable<typeof asked.prompt>, { kind: 'signature' }>;
    const tampered = { ...(p.payload as { userOp: GenesisUserOpJson }).userOp, callData: '0xcallabc' };
    const r = await run(g.deps, { parent: WORKSPACE }, [...supplied, { stepRef: 's0', signature: { digest: p.digest, signer: EOA, signature: '0xsig', payload: { userOp: tampered } } }]);
    expect('error' in r ? r.error : '').toContain('not the one this ask derives');
    expect(g.deps.submit).not.toHaveBeenCalled();
  });

  it('refuses a signature whose digest is not the EntryPoint hash of the supplied op', async () => {
    const g = fakeGenesis();
    const supplied = [{ stepRef: 's0', data: { label: 'xyz', custodian: { kind: 'eoa', address: EOA } } }];
    const asked = await run(g.deps, { parent: WORKSPACE }, supplied);
    const p = asked.prompt as Extract<NonNullable<typeof asked.prompt>, { kind: 'signature' }>;
    const r = await run(g.deps, { parent: WORKSPACE }, [...supplied, { stepRef: 's0', signature: { digest: '0xhash-other', signer: EOA, signature: '0xsig', payload: p.payload } }]);
    expect('error' in r ? r.error : '').toContain('is not the hash of the supplied userOp');
    expect(g.deps.submit).not.toHaveBeenCalled();
  });

  it('a resume after the team already exists is a no-op that reports the team (idempotent on the ask) — its own name is not "taken"', async () => {
    const g = fakeGenesis({ isDeployed: vi.fn(async () => true), resolveName: vi.fn(async () => CHILD) });
    const r = await run(g.deps, { parent: WORKSPACE }, [{ stepRef: 's0', data: { label: 'xyz', custodian: { kind: 'eoa', address: EOA } } }]);
    expect(r.ok).toBe(true);
    expect('result' in r ? r.result : null).toMatchObject({ agent: CHILD, name: 'xyz.team', alreadyCreated: true });
    expect(g.deps.submit).not.toHaveBeenCalled();
  });

  it('an organization is the SAME ceremony under the person\'s own authority — <label>.org, custodied by them', async () => {
    const g = fakeGenesis();
    const personWire: Delegation = { ...wire, delegator: PERSON };
    const inv = childAgentCreateInvoker(g.deps, env, { ref: '0xm', wire: personWire }, PERSON);
    const supplied = [{ stepRef: 's0', data: { label: 'missio', custodian: { kind: 'eoa', address: EOA } } }];
    let prompt: unknown;
    try { await inv('organization.create', { parent: PERSON }, ctxWith(supplied)); } catch (e) { prompt = isInputRequired(e) ? e.request : e; }
    expect(prompt).toMatchObject({ kind: 'signature', prompt: expect.stringContaining('missio.org') });
    expect(g.built[0]).toMatchObject({ tld: 'org', parent: PERSON });
  });

  it('the intent digest the salts derive from is the canonical one', () => {
    expect(intentDigest(intent)).toBe(intentDigest({ context: { parent: WORKSPACE }, goal: intent.goal }));
  });
});

describe('the ask reply (what the surface is told)', () => {
  const env2 = { ...env, HARNESS_AGENT_SA: HARNESS } as HarnessEnv;
  const base = { runRef: 'r1', plan: { steps: [] }, steps: [], receipts: [] } as const;

  it('authority-required becomes the requirement to sign — delegator = the parent the step names, never the asker', async () => {
    const reply = await askReplyFor(env2, {
      intent, addressee: WORKSPACE as `0x${string}`,
      result: { ...base, outcome: 'authority-required', required: { stepRef: 's0', toolId: 'organization.team.create', capability: { id: 'organization.team.create', action: 'create', resource: WORKSPACE }, risk: 'medium', args: {} } } as never,
    });
    expect(reply).toMatchObject({ kind: 'authority_required', delegator: WORKSPACE, delegate: HARNESS, capability: 'organization.team.create' });
    expect(reply.kind === 'authority_required' ? reply.requirement : null).toMatchObject({ actions: ['organization.team.create'], locations: [WORKSPACE], intentDigest: intentDigest(intent) });
  });

  it('a completed run that only READ is an answer; one that acted is done', async () => {
    const readOnly = await askReplyFor(env2, { intent, addressee: WORKSPACE as `0x${string}`, result: { ...base, outcome: 'completed', result: 'four teams', receipts: [{ status: 'executed', risk: 'informational' }] } as never });
    expect(readOnly).toMatchObject({ kind: 'answer', text: 'four teams' });
    const acted = await askReplyFor(env2, { intent, addressee: WORKSPACE as `0x${string}`, result: { ...base, outcome: 'completed', result: { agent: CHILD }, receipts: [{ status: 'executed', risk: 'medium' }] } as never });
    expect(acted.kind).toBe('done');
  });

  it('a denial is refused, and says so — never dressed up as a request for authority', async () => {
    const reply = await askReplyFor(env2, { intent, addressee: WORKSPACE as `0x${string}`, result: { ...base, outcome: 'denied', error: 'intent-mismatch: …' } as never });
    expect(reply).toMatchObject({ kind: 'refused', outcome: 'denied' });
  });

  it('a prompt is passed through with its resume token', async () => {
    const prompt = { kind: 'data', stepRef: 's0', toolId: 'organization.team.create', prompt: 'What should the team be called?', fields: [] } as const;
    const reply = await askReplyFor(env2, { intent, addressee: WORKSPACE as `0x${string}`, result: { ...base, outcome: 'suspended', resumeToken: 's0', prompt } as never });
    expect(reply).toMatchObject({ kind: 'prompt', resumeToken: 's0', prompt });
  });
});

describe('composing the answer (spec 350 §3.7)', () => {
  const env2 = { ...env, HARNESS_AGENT_SA: HARNESS } as HarnessEnv;
  const base = { runRef: 'r1', plan: { steps: [] }, steps: [], receipts: [] } as const;
  const readRun = (steps: unknown[]) => ({ ...base, outcome: 'completed', result: { agents: [{ name: 'outreach.team' }] }, steps, receipts: [{ status: 'executed', risk: 'informational' }] }) as never;
  const observations = [
    { step: { toolId: 'find_agents', args: { terms: 'outreach' } }, ok: true, result: { agents: [{ name: 'outreach.team' }] } },
    { step: { toolId: 'find_agents', args: { terms: 'x' } }, ok: false, error: 'boom' },
  ];

  it('renders a question\'s result in words, from the observations', async () => {
    const compose = vi.fn(async () => 'There is one: outreach.team.');
    const reply = await askReplyFor(env2, { intent, addressee: WORKSPACE as `0x${string}`, result: readRun(observations), composer: { compose } });
    expect(reply).toMatchObject({ kind: 'answer', text: 'There is one: outreach.team.' });
    // Spec 391 — the composer is also handed its FITTED evidence (the observations, within its budget).
    expect(compose).toHaveBeenCalledWith(expect.objectContaining({ intent, observations }));
  });

  it('never paraphrases an ACTION — what happened is stated from the receipt', async () => {
    const compose = vi.fn(async () => 'I made you a team!');
    const reply = await askReplyFor(env2, {
      intent, addressee: WORKSPACE as `0x${string}`, composer: { compose },
      result: { ...base, outcome: 'completed', result: { agent: CHILD, name: 'xyz.team' }, receipts: [{ status: 'executed', risk: 'medium' }] } as never,
    });
    expect(reply.kind).toBe('done');
    expect(compose).not.toHaveBeenCalled();
  });

  it('degrades to the raw result when there is no composer, or it fails — the evidence is identical either way', async () => {
    const none = await askReplyFor(env2, { intent, addressee: WORKSPACE as `0x${string}`, result: readRun(observations) });
    expect(none).toMatchObject({ kind: 'answer', text: '{"agents":[{"name":"outreach.team"}]}' });
    const broken = await askReplyFor(env2, { intent, addressee: WORKSPACE as `0x${string}`, result: readRun(observations), composer: { compose: async () => { throw new Error('down'); } } });
    // Spec 377 — a composer that FAILED says so beside the evidence ("could not be put into words"); the
    // evidence itself is still the raw result, first and unchanged.
    expect(broken.kind).toBe('answer');
    expect((broken as { text?: string }).text?.startsWith('{"agents":[{"name":"outreach.team"}]}')).toBe(true);
    expect((broken as { text?: string }).text).toMatch(/could not be put into words/);
  });
});

describe('inviting a member (organization.membership.invite)', () => {
  const ORG = WORKSPACE;
  const INVITEE = '0x4444444444444444444444444444444444444444';
  const orgWire: Delegation = { ...wire, delegator: ORG };
  const inv = (supplied?: InvokeContext['supplied'], args: Record<string, unknown> = { org: ORG, invitee: INVITEE }) =>
    inviteInvoker(env, { ref: '0xm', wire: orgWire }, PERSON)('organization.membership.invite', args, ctxWith(supplied));
  const caught = async (p: Promise<unknown>) => { try { return { ok: true as const, v: await p }; } catch (e) { return isInputRequired(e) ? { ok: false as const, prompt: e.request } : { ok: false as const, error: (e as Error).message }; } };

  it('asks WHO when the ask did not name an address', async () => {
    const r = await caught(inv(undefined, { org: ORG, invitee: 'alice' }));
    expect(r.prompt).toMatchObject({ kind: 'data', fields: [{ name: 'invitee', type: 'address' }] });
  });

  it('the invitation is issued by the mandate\'s delegator, never another organization', async () => {
    const r = await caught(inv(undefined, { org: PERSON, invitee: INVITEE }));
    expect('error' in r ? r.error : '').toContain("issued by the mandate's delegator");
  });

  it('asks the steward to sign the grant — and the grant is what the invitee will hold', async () => {
    const r = await caught(inv());
    expect(r.prompt).toMatchObject({ kind: 'signature', signer: ORG, payload: { org: ORG, invitee: INVITEE, scope: 'vault:org.profile' } });
    const again = await caught(inv());
    expect((again.prompt as { digest: string }).digest).toBe((r.prompt as { digest: string }).digest); // deterministic: a resume rebuilds what was signed
  });

  it('returns the SIGNED grant for the surface to store — an invitation nobody stored is a promise nobody can find', async () => {
    const asked = await caught(inv());
    const p = asked.prompt as { digest: string };
    const done = await caught(inv([{ stepRef: 's0', signature: { digest: p.digest, signer: ORG, signature: '0xsig' } }]));
    expect(done.ok).toBe(true);
    expect(done.v).toMatchObject({ org: ORG, invitee: INVITEE, invited: true, memberAccessDelegation: { delegator: ORG, delegate: INVITEE, signature: '0xsig' } });
  });

  it('refuses the invitations that mean nothing', async () => {
    expect('error' in (await caught(inv(undefined, { org: ORG, invitee: ORG }))) ? (await caught(inv(undefined, { org: ORG, invitee: ORG }))).error : '').toContain('cannot invite itself');
    const self = await caught(inv(undefined, { org: ORG, invitee: PERSON }));
    expect('error' in self ? self.error : '').toContain('already the steward');
  });
});

describe('how much to fund (an amount is never guessed)', () => {
  it('takes smallest units, or whole USDC — each in its own argument', () => {
    expect(fundingAmount({ amount: '12110000' })).toBe(12_110_000n);
    expect(fundingAmount({ usdc: '12.11' })).toBe(12_110_000n);
    expect(fundingAmount({ usdc: '5' })).toBe(5_000_000n);
    expect(fundingAmount({ usdc: '0.000001' })).toBe(1n);
  });

  it('refuses a decimal in the smallest-units field rather than reading it as units', () => {
    expect(() => fundingAmount({ amount: '12.11' })).toThrow(/whole smallest units/);
  });

  it('refuses to invent an amount when none was given', () => {
    expect(() => fundingAmount({})).toThrow(/how much/);
    expect(() => fundingAmount({ usdc: 'a lot' })).toThrow(/not an amount/);
  });
});

describe('what the surface says it supports (spec 352 §2 — scoping is disclosure, never authority)', () => {
  const ids = (s?: Parameters<typeof scopedActionTools>[0]) => scopedActionTools(s).map((t) => t.capability?.id ?? t.id);

  it('offers everything when the surface says nothing', () => {
    expect(ids()).toEqual(expect.arrayContaining(['treasury.payment.execute', 'organization.create', 'messaging.direct.send']));
  });

  it('a surface NARROWS to what it can carry to completion', () => {
    expect(ids({ capabilities: ['messaging.direct.send'] })).toEqual(['messaging.direct.send']);
  });

  it('a surface cannot ADD a capability by naming one — narrowing only', () => {
    expect(ids({ capabilities: ['treasury.liquidate.everything'] })).toEqual([]);
  });

  it('the realm narrows too: an organization charters what lives inside it, not another organization', () => {
    expect(ids({ realm: { kind: 'org' } })).not.toContain('organization.create');
    expect(ids({ realm: { kind: 'org' } })).toContain('organization.team.create');
  });

  it('a service realm charters no agents and invites nobody', () => {
    const svc = ids({ realm: { kind: 'service' } });
    expect(svc).not.toContain('organization.team.create');
    expect(svc).not.toContain('organization.membership.invite');
    expect(svc).toContain('treasury.payment.execute'); // a service can still be asked to pay under a mandate
  });
});

describe('the scope/authority firewall (spec 353 §4)', () => {
  it('scope is not a parameter of any gate — it is consumed before authority, and threading it in is the drift to refuse', async () => {
    // Structural, not aspirational: the verifier and the policy evaluator are built without it, so a PR
    // that wanted to use scope in a decision would have to change their signatures — visibly.
    const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../src/harness-run.ts', import.meta.url), 'utf8'));
    const afterVerifier = src.slice(src.indexOf('delegationMandateVerifier({'));
    expect(afterVerifier.slice(0, 600)).not.toMatch(/surface|AskScopeV1/);
    expect(src).not.toMatch(/riskLadderPolicy\([^)]*surface/);
  });

  it('carries no standing: an app may say WHERE you are, never WHAT you are to it', () => {
    // `role` was carried for one commit and is removed rather than ignored — a field that exists gets used.
    const scope = { capabilities: ['treasury.payment.execute'], realm: { kind: 'org' as const } };
    expect(Object.keys(scope.realm)).toEqual(['kind']);
    expect(scopedActionTools(scope).map((t) => t.capability?.id)).toEqual(['treasury.payment.execute']);
  });
});

describe('saying "this agent cannot do that here" (spec 353 S2)', () => {
  it('the refusal tool is offered alongside the capabilities, so the planner is never cornered', () => {
    // A planner that MUST pick a tool will pick the nearest one; asked to create a treasury with no
    // treasury capability it created an organization. This is the way out.
    expect(UNSUPPORTED_TOOL.id).toBe('ask.unsupported');
    expect(UNSUPPORTED_TOOL.capability).toBeUndefined(); // saying no is not an action and needs no authority
  });

  it('states the refusal and lists what this agent CAN do — never composes prose around it', async () => {
    const env2 = { ...env, HARNESS_AGENT_SA: HARNESS } as HarnessEnv;
    const composer = { compose: vi.fn(async () => 'Perhaps you would like me to try something else!') };
    const reply = await askReplyFor(env2, {
      intent: { goal: 'book me a flight' }, addressee: WORKSPACE as `0x${string}`, composer,
      result: {
        runRef: 'r', plan: { steps: [] }, receipts: [{ status: 'executed', risk: 'informational' }],
        outcome: 'completed', result: { unsupported: true },
        steps: [{ step: { toolId: 'ask.unsupported', args: {} }, ok: true, result: { unsupported: true, what: 'book you a flight', available: ['treasury.payment.execute', 'organization.team.create'] } }],
      } as never,
    });
    expect(reply.kind).toBe('answer');
    expect(reply.kind === 'answer' ? reply.text : '').toBe("I can't help with “book you a flight” here. What I can do as this agent: make payments, create teams.");
    expect(composer.compose).not.toHaveBeenCalled();
  });

  it('lists nothing rather than inventing when the agent offers nothing', async () => {
    const env2 = { ...env, HARNESS_AGENT_SA: HARNESS } as HarnessEnv;
    const reply = await askReplyFor(env2, {
      intent: { goal: 'x' }, addressee: WORKSPACE as `0x${string}`,
      result: {
        runRef: 'r', plan: { steps: [] }, receipts: [], outcome: 'completed', result: {},
        steps: [{ step: { toolId: 'ask.unsupported', args: {} }, ok: true, result: { unsupported: true, what: 'do that', available: [] } }],
      } as never,
    });
    expect(reply.kind === 'answer' ? reply.text : '').toBe("I can't help with “do that” here.");
  });
});

describe('ceremony negotiation (spec 353 S4)', () => {
  const env2 = { ...env, HARNESS_AGENT_SA: HARNESS } as HarnessEnv;

  it('every capability that will ask for a signature says so — risk alone does not predict it', () => {
    // team-create is MEDIUM and still needs one, because an agent's genesis is signed by its custodian.
    expect(CAPABILITY_CEREMONIES['organization.team.create']).toContain('signature');
    expect(CAPABILITY_CEREMONIES['treasury.payment.execute']).toContain('signature');
  });

  it('a surface that cannot collect a signature is not OFFERED what needs one', () => {
    const ids = scopedActionTools({ ceremonies: ['data', 'confirmation'] }).map((t) => t.capability?.id ?? t.id);
    // What survives is exactly what asks for no signature: the two SELF-ACTING capabilities, which write
    // the person's own records under their own session (their contact details, and their note of who they
    // live with). The Home's forms ask for nothing either, and a conversation that demanded a signature
    // the button does not would make talking the expensive way. Every other action here binds authority a
    // person signs, and none of them is offered.
    expect(ids).toEqual(['household.member.record', 'profile.contact.update']);
    expect(scopedActionTools({ ceremonies: ['data', 'confirmation', 'signature'] }).length).toBeGreaterThan(0);
  });

  it('silence is not a narrowing — a surface that has not said what it renders gets everything', () => {
    expect(scopedActionTools({}).length).toBeGreaterThan(0);
    expect(surfaceCanRender('treasury.payment.execute', undefined)).toBe(true);
    expect(surfaceCanRender('treasury.payment.execute', [])).toBe(true);
  });

  it('a run that WOULD suspend on an undeclared prompt is refused, with the ceremony named', async () => {
    const prompt = { kind: 'signature', stepRef: 's0', toolId: 'treasury.payment.execute', prompt: 'Sign', digest: '0xd', signer: '0xs' } as const;
    const reply = await askReplyFor(env2, {
      intent: { goal: 'pay' }, addressee: WORKSPACE as `0x${string}`,
      surface: { ceremonies: ['data', 'confirmation'] },
      result: { runRef: 'r', plan: { steps: [] }, steps: [], receipts: [], outcome: 'suspended', resumeToken: 's0', prompt } as never,
    });
    expect(reply).toMatchObject({ kind: 'refused', error: expect.stringContaining('cannot collect') });
    expect(reply.kind === 'refused' ? reply.error : '').toContain('signature');
  });

  it('a prompt the surface DID declare still suspends normally', async () => {
    const prompt = { kind: 'signature', stepRef: 's0', toolId: 'x', prompt: 'Sign', digest: '0xd', signer: '0xs' } as const;
    const reply = await askReplyFor(env2, {
      intent: { goal: 'pay' }, addressee: WORKSPACE as `0x${string}`,
      surface: { ceremonies: ['data', 'confirmation', 'signature'] },
      result: { runRef: 'r', plan: { steps: [] }, steps: [], receipts: [], outcome: 'suspended', resumeToken: 's0', prompt } as never,
    });
    expect(reply.kind).toBe('prompt');
  });

  it('a data prompt is always answerable — a conversation that cannot ask a question is not one', async () => {
    const prompt = { kind: 'data', stepRef: 's0', toolId: 'x', prompt: 'What name?', fields: [] } as const;
    const reply = await askReplyFor(env2, {
      intent: { goal: 'x' }, addressee: WORKSPACE as `0x${string}`,
      surface: { ceremonies: ['signature'] },
      result: { runRef: 'r', plan: { steps: [] }, steps: [], receipts: [], outcome: 'suspended', resumeToken: 's0', prompt } as never,
    });
    expect(reply.kind).toBe('prompt');
  });
});
