// Slice S5 — THE WORKSPACE FETCHES WHAT IT WAS GRANTED. `library.granted.fetch` on the workspace's own agent sends the
// publisher's agent a `library.granted.read` task AS THE WORKSPACE, over the delegated-task rail (`submitDelegatedTask` →
// `readDelegatedTask` → `readTaskArtifact`), signed under the workspace's own signing wire.
//
// The publisher here is an A2A DOUBLE of its task object that does what #74's door does with real keys: it reads the
// delegated-task extension, verifies the SESSION-WRAPPED sender signature with the package's own
// `verifySessionWrappedSignature` (wire shape + the skill pinned + ECDSA to the session key + the wire's signature by the
// workspace), checks the sender is the grant's delegate, and then runs the REAL `grantedLibraryRead` over its Library with a
// grant the publisher's key signed. So "the gate accepts the message as the workspace's" is exercised, not assumed.
import { describe, expect, it } from 'vitest';
import { keccak256, recoverAddress, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import {
  buildMethodAuthorityCaveats, buildVaultRecordScopeCaveat, buildCaveat, buildSessionDelegation, encodeTimestampTerms, encodeAllowedTargetsTerms, encodeAllowedMethodsTerms,
  hashDelegation, type Delegation, type EnforcerAddressMap,
} from '@agenticprimitives/delegation';
import { checkSessionWireShape, hashA2aMessage, skillSelector, verifySessionWrappedSignature } from '@agenticprimitives/a2a';
import { delegatedInput, readDelegatedTask, toProfileMessage, type MessageV1 } from '@agenticprimitives/a2a/standard';
import {
  libraryInvoker, grantedLibraryRead, libraryEntryScope, LIBRARY_GRANTED_FETCH, LIBRARY_GRANTED_READ, LIBRARY_TEXT_MAX_CHARS,
  type LibraryEntry, type LibraryGrantChecks, type LibraryToolDeps,
} from '../src/library-tools.js';
import { grantedReadSender, type GrantedReadSenderDeps } from '../src/library-granted-fetch.js';
import type { Env, IncomingDelegation } from '../src/index.js';
import { HARNESS_ACTION_TOOLS } from '../src/harness-run.js';
import { LIBRARY_TOOLS } from '../src/library-tools.js';

const PUBLISHER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const WORKSPACE_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const SESSION_PK = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;
const PUBLISHER = privateKeyToAccount(PUBLISHER_PK).address.toLowerCase() as Address; // stands in for the publisher's SA
const WORKSPACE = privateKeyToAccount(WORKSPACE_PK).address.toLowerCase() as Address; // stands in for the workspace .svc SA
const SESSION_KEY = privateKeyToAccount(SESSION_PK).address.toLowerCase() as Address; // the interactions-session KMS key
const PERSON = ('0x' + 'c3'.repeat(20)) as Address;   // the workspace's steward (the person who chartered it)
const STRANGER = ('0x' + 'b2'.repeat(20)) as Address;
const OTHER = ('0x' + 'e4'.repeat(20)) as Address;
const CHAIN = 34348;
const DM = ('0x' + 'd0'.repeat(20)) as Address;
const VAULT = 'demo-mcp';
const E: EnforcerAddressMap = {
  delegationManager: DM,
  timestamp: ('0x' + '11'.repeat(20)) as Address,
  value: ('0x' + '12'.repeat(20)) as Address,
  allowedTargets: ('0x' + '13'.repeat(20)) as Address,
  allowedMethods: ('0x' + '14'.repeat(20)) as Address,
};
const NOW = Math.floor(Date.now() / 1000);

// The publisher's Library: a long restricted page under the grant, and a private diary outside it.
const LONG = 'In the beginning '.repeat(1500); // 25,500 chars — three pages
const enc = (t: string) => btoa(unescape(encodeURIComponent(t)));
const catalog: LibraryEntry[] = [
  { id: 'art-restricted', kind: 'md', name: 'work.md', folder: 'works/restricted', accessPolicy: 'private', version: 1 },
  { id: 'art-diary', kind: 'md', name: 'diary.md', folder: 'personal', accessPolicy: 'private', version: 1 },
];
const bodies: Record<string, string> = { 'art-restricted': LONG, 'art-diary': 'my private diary' };
const ecdsa = async ({ signer, digest, signature }: { signer: string; digest: Hex; signature: Hex }) => (await recoverAddress({ hash: digest, signature }).catch(() => '0x')).toLowerCase() === signer.toLowerCase();
const publisherChecks: LibraryGrantChecks = {
  enforcers: E, vaultServer: VAULT,
  delegationDigest: (d) => hashDelegation(d, CHAIN, DM),
  isRevoked: async () => false,
  verifySignature: ecdsa, // ECDSA in place of the ERC-1271 read: the test "agent" is its key's address
};
const publisherDeps: LibraryToolDeps = {
  readSubjectRecord: async (subject, type) => {
    if (subject !== PUBLISHER) return null;
    if (type === 'content.catalog') return structuredClone(catalog);
    const id = type.replace(/^content\.artifact\./, '');
    return bodies[id] !== undefined ? { id, bytesB64: enc(bodies[id]!) } : null;
  },
  grantChecks: publisherChecks,
};

/** The publisher's grant to a delegate (as library.grant.issue signs it). */
async function grantOf(o: { delegator?: Address; delegate?: Address; signer?: Hex } = {}) {
  const delegator = o.delegator ?? PUBLISHER;
  const caveats = [
    ...buildMethodAuthorityCaveats({ target: delegator, method: LIBRARY_GRANTED_READ, enforcers: E, window: { validAfter: NOW - 60, validUntil: NOW + 3600 } }),
    buildVaultRecordScopeCaveat([{ server: VAULT, resources: [libraryEntryScope('art-restricted')], ops: ['read'] }]),
  ];
  const unsigned: Delegation = { delegator, delegate: o.delegate ?? WORKSPACE, authority: `0x${'f'.repeat(64)}` as Hex, caveats, salt: 7n, signature: '0x' };
  const signature = await sign({ hash: hashDelegation(unsigned, CHAIN, DM), privateKey: o.signer ?? PUBLISHER_PK, to: 'hex' });
  return { ...unsigned, salt: '7', signature };
}

/** The workspace's own A2A signing wire: workspace → the session key, the skill pinned, signed by the workspace's custodian. */
async function signingWireOf(skills: string[] = [LIBRARY_GRANTED_READ]): Promise<IncomingDelegation> {
  const unsigned: Delegation = {
    delegator: WORKSPACE, delegate: SESSION_KEY, authority: `0x${'f'.repeat(64)}` as Hex, salt: 11n, signature: '0x',
    caveats: [
      buildCaveat(E.timestamp, encodeTimestampTerms(0, NOW + 86_400)),
      buildCaveat(E.allowedTargets, encodeAllowedTargetsTerms([WORKSPACE])),
      buildCaveat(E.allowedMethods, encodeAllowedMethodsTerms(skills.map((s) => skillSelector(s)))),
    ],
  };
  const signature = await sign({ hash: hashDelegation(unsigned, CHAIN, DM), privateKey: WORKSPACE_PK, to: 'hex' });
  return { ...unsigned, salt: '11', signature } as unknown as IncomingDelegation;
}

interface Seen { sent: Array<{ sender: string; principal: string; skill: string; input: Record<string, unknown> }>; tasks: Map<string, { sender: string; state: string; error?: string; body?: unknown }> }

/** The publisher's task object, as an A2A double: #74's door checks with real keys, then the real granted read. */
function publisherDouble(seen: Seen) {
  const reply = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
  return {
    idFromName: (n: string) => n,
    get: (agent: string) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const body = (await req.json()) as Record<string, any>;
        if (url.pathname === '/internal/consult-artifact') {
          const t = seen.tasks.get(body.taskId);
          if (!t || t.sender !== body.caller) return reply({ ok: false, error: 'only the task sender may read its artifacts' });
          return reply({ ok: true, body: t.body });
        }
        const { rpc, principal } = body as { rpc: { id: string; method: string; params: Record<string, any> }; principal: { agent: string } };
        if (agent !== PUBLISHER) return reply({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'not the publisher' } });
        if (rpc.method === 'GetTask') {
          const t = seen.tasks.get(rpc.params.id);
          if (!t || t.sender !== principal.agent) return reply({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: 'not a party to this task' } });
          return reply({ jsonrpc: '2.0', id: rpc.id, result: {
            id: rpc.params.id, contextId: 'c',
            status: { state: t.state === 'completed' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED', ...(t.error ? { message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: t.error }] } } : {}) },
            artifacts: t.state === 'completed' ? [{ artifactId: 'art-1', parts: [] }] : [],
          } });
        }
        // SendMessage — the door's checks on the delegated-task extension.
        const message = rpc.params.message as MessageV1;
        const ext = readDelegatedTask(message);
        if (!ext || 'error' in ext) return reply({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'no delegated task' } });
        const input = delegatedInput(message) as Record<string, unknown>;
        seen.sent.push({ sender: ext.sender, principal: principal.agent, skill: ext.skill, input });
        const deny = (m: string) => reply({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: m } });
        if (ext.sender.toLowerCase() !== principal.agent) return deny('message sender != authenticated caller');
        if (ext.delegation.delegate.toLowerCase() !== ext.sender.toLowerCase()) return deny('delegate != requester');
        if (keccak256(toBytes(JSON.stringify(input))) !== ext.bodyHash) return deny('body hash mismatch');
        const sigOk = await verifySessionWrappedSignature({
          signer: ext.sender as Address, digest: hashA2aMessage(toProfileMessage(message, ext) as never), signature: ext.signature,
          enforcers: { timestamp: E.timestamp, allowedMethods: E.allowedMethods },
          verifyDelegationSig: async (d) => ecdsa({ signer: d.delegator, digest: hashDelegation(d, CHAIN, DM), signature: d.signature as Hex }),
          isRevoked: async () => false,
          skill: ext.skill,
        });
        if (!sigOk) return deny('message signature invalid');
        if (ext.skill !== LIBRARY_GRANTED_READ) return deny('unknown skill');
        // The skill (`makeLibraryGrantedReadSkill`): the task's delegation is the grant, the sender the caller.
        const out = await grantedLibraryRead(publisherDeps, PUBLISHER, ext.sender, { ...input, grant: ext.delegation });
        const taskId = `0x${String(seen.tasks.size + 1).padStart(64, '0')}`;
        seen.tasks.set(taskId, out.read === true ? { sender: ext.sender.toLowerCase(), state: 'completed', body: out } : { sender: ext.sender.toLowerCase(), state: 'failed', error: String(out.refused) });
        return reply({ jsonrpc: '2.0', id: rpc.id, result: { task: { id: taskId, contextId: 'c', status: { state: 'TASK_STATE_SUBMITTED' } } } });
      },
    }),
  };
}

const envOf = (seen: Seen) => ({ A2A_TASKS: publisherDouble(seen), TIMESTAMP_ENFORCER: E.timestamp, ALLOWED_METHODS_ENFORCER: E.allowedMethods, A2A_INTERNAL_MARKER: 'marker-for-tests-0123456789abcdef' } as unknown as Env);
const signRaw = async ({ hash }: { hash: Hex }) => sign({ hash, privateKey: SESSION_PK, to: 'hex' });

/** The workspace's agent, its steward the person who chartered it. */
async function workspaceInvoker(opts: { senderDeps?: Partial<GrantedReadSenderDeps> } = {}) {
  const seen: Seen = { sent: [], tasks: new Map() };
  const wire = await signingWireOf();
  const fetchGranted = grantedReadSender(envOf(seen), { signingWire: async (a) => (a === WORKSPACE ? wire : null), signRaw, everyMs: 1, deadlineMs: 2000, ...opts.senderDeps });
  const deps: LibraryToolDeps = {
    readSubjectRecord: async () => null,
    stewardOf: async (who, owner) => (who === PERSON && owner === WORKSPACE ? { steward: true, because: 'you chartered it' } : { steward: false, because: `${who} holds no stewardship over ${owner}` }),
    fetchGranted,
  };
  return { seen, inv: (person: string | undefined) => libraryInvoker(deps, WORKSPACE, person) };
}
const ctx = { step: { toolId: LIBRARY_GRANTED_FETCH, args: {} }, index: 0, intent: { goal: 'read the work' } } as never;

describe('library.granted.fetch — the workspace reads what a publisher granted it', () => {
  it('a STEWARD of the workspace is admitted; the publisher\'s gate takes the message as the workspace\'s; the artifact comes back unchanged', async () => {
    const { seen, inv } = await workspaceInvoker();
    const grant = await grantOf();
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant }, ctx)) as Record<string, any>;
    expect(out.read).toBe(true);
    expect(out.owner).toBe(PUBLISHER);
    expect(out.file.id).toBe('art-restricted');
    expect(out.text).toBe(LONG.slice(0, LIBRARY_TEXT_MAX_CHARS));
    expect(out.chars).toBe(LONG.length);
    expect(out.truncated).toBe(true);
    expect(out.untrusted).toBe(true);
    expect(out.grant.delegationHash).toBe(hashDelegation({ ...grant, salt: 7n } as Delegation, CHAIN, DM));
    expect(out.grant.expiresAt).toBe(new Date((NOW + 3600) * 1000).toISOString());
    expect(out.via).toEqual({ publisher: PUBLISHER, taskId: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    // Sent AS the workspace (the delegate), never as the person asking; input is { id } — the grant rides as the delegation.
    expect(seen.sent).toEqual([{ sender: WORKSPACE, principal: WORKSPACE, skill: LIBRARY_GRANTED_READ, input: { id: 'art-restricted' } }]);
  });

  it('the workspace itself (its own run) is admitted the same way', async () => {
    const { inv } = await workspaceInvoker();
    const out = (await inv(WORKSPACE)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(out.read).toBe(true);
  });

  it('a STRANGER is refused in words, and nothing is sent', async () => {
    const { seen, inv } = await workspaceInvoker();
    const out = (await inv(STRANGER)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(out.read).toBe(false);
    expect(out.refused).toMatch(/fetched by the workspace itself or by a steward of it — .*holds no stewardship/);
    expect(seen.sent).toHaveLength(0);
  });

  it('a run with no signed-in person is refused', async () => {
    const { seen, inv } = await workspaceInvoker();
    const out = (await inv(undefined)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(out.refused).toMatch(/no signed-in person/);
    expect(seen.sent).toHaveLength(0);
  });

  it('a grant made to ANOTHER delegate is refused before anything is sent — a workspace presents only its own grants', async () => {
    const { seen, inv } = await workspaceInvoker();
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantOf({ delegate: OTHER }) }, ctx)) as Record<string, any>;
    expect(out.read).toBe(false);
    expect(out.refused).toBe(`the grant names ${OTHER} as its delegate — a workspace presents only grants made to itself (${WORKSPACE})`);
    expect(seen.sent).toHaveLength(0);
  });

  it('a grant from someone other than the publisher named is refused before anything is sent', async () => {
    const { seen, inv } = await workspaceInvoker();
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: OTHER, id: 'art-restricted', grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(out.read).toBe(false);
    expect(out.refused).toBe(`the grant is from ${PUBLISHER}, not from the publisher named (${OTHER})`);
    expect(seen.sent).toHaveLength(0);
  });

  it('the PUBLISHER\'s refusal comes back in its words (a document outside the grant)', async () => {
    const { seen, inv } = await workspaceInvoker();
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-diary', grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(seen.sent).toHaveLength(1);
    expect(out.read).toBe(false);
    expect(out.refused).toBe('no document by that id is readable under this grant');
    expect(out.via).toEqual({ publisher: PUBLISHER, taskId: expect.stringMatching(/^0x/) });
  });

  it('the publisher\'s refusal of a grant it did not sign is passed through too', async () => {
    const { inv } = await workspaceInvoker();
    const forged = await grantOf({ signer: WORKSPACE_PK }); // names the publisher as delegator, signed by someone else
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: forged }, ctx)) as Record<string, any>;
    expect(out.read).toBe(false);
    expect(out.refused).toBe(`the grant does not admit this read — it is not signed by ${PUBLISHER} (ERC-1271)`);
  });

  it('paging: `offset` is passed to the publisher and its page comes back', async () => {
    const { seen, inv } = await workspaceInvoker();
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', offset: 2 * LIBRARY_TEXT_MAX_CHARS, grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(seen.sent[0]!.input).toEqual({ id: 'art-restricted', offset: 2 * LIBRARY_TEXT_MAX_CHARS });
    expect(out.offset).toBe(2 * LIBRARY_TEXT_MAX_CHARS);
    expect(out.text).toBe(LONG.slice(2 * LIBRARY_TEXT_MAX_CHARS));
    expect(out.truncated).toBe(false);
  });

  it('a signing wire that does not name library.granted.read is refused HERE, before the publisher sees a message', async () => {
    const consultOnly = await signingWireOf(['discussion.consult']);
    const { seen, inv } = await workspaceInvoker({ senderDeps: { signingWire: async () => consultOnly } });
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(out.refused).toMatch(/signing wire cannot sign a granted read \(session wire allowedMethods does not name the library\.granted\.read selector\)/);
    expect(seen.sent).toHaveLength(0);
  });

  it('no signing wire at all is said in words', async () => {
    const { seen, inv } = await workspaceInvoker({ senderDeps: { signingWire: async () => null } });
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(out.refused).toMatch(/holds no signing wire of its own/);
    expect(seen.sent).toHaveLength(0);
  });

  it('a publisher served by another deployment is refused by name', async () => {
    const { seen, inv } = await workspaceInvoker({ senderDeps: { where: async () => ({ here: false, refused: 'pub.svc is served by another deployment' }) } });
    const out = (await inv(PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantOf() }, ctx)) as Record<string, any>;
    expect(out.refused).toBe(`the publisher ${PUBLISHER} cannot be asked from here: pub.svc is served by another deployment`);
    expect(seen.sent).toHaveLength(0);
  });

  it('WHY NOT THE SESSION LEAF: the DEL-001 leaf (signAsAgent) has no allowedMethods, so no A2A gate would take a message under it', () => {
    const { leaf } = buildSessionDelegation({ delegator: WORKSPACE, sessionKeyAddress: SESSION_KEY, presentsTo: [OTHER], validUntil: NOW + 3600, enforcers: { timestamp: E.timestamp, value: E.value }, chainId: CHAIN, delegationManager: DM });
    expect(checkSessionWireShape({ ...leaf, salt: leaf.salt.toString() } as never, { timestamp: E.timestamp, allowedMethods: E.allowedMethods }, NOW, { skill: LIBRARY_GRANTED_READ }))
      .toBe('session wire must carry an allowedMethods caveat');
  });

  it('is a READ — no capability, no mandate, no ceremony — and never an action tool a plan can carry as an act', () => {
    const t = LIBRARY_TOOLS.find((x) => x.id === LIBRARY_GRANTED_FETCH)!;
    expect(t.establishes).toBe('lookup');
    expect(t.capability).toBeUndefined();
    expect(HARNESS_ACTION_TOOLS.some((x) => x.id === LIBRARY_GRANTED_FETCH)).toBe(false);
  });
});
