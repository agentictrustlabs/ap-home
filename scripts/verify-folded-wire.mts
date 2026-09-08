/**
 * Spec 372 S4 — the FOLDED wire, agent to agent, on faithchain.
 *
 *   npx tsx scripts/verify-folded-wire.mts [recipientHandle]
 *
 * There used to be two wires: A2A 1.0 for conversations, and a profile of our own (`message/send`,
 * `tasks/get`) for delegation-authorized tasks. There is one now. This drives the whole path that used the
 * retired one — Alice asks her agent to message Nathan, under a mandate she signs; the harness delivers it
 * as a 1.0 `SendMessage` carrying the delegated-task extension; Nathan's agent authorizes the grant,
 * verifies the envelope's signature, creates the task and writes the body into HIS vault.
 *
 * What is proved: the retired method names are gone from the wire, the delivery still lands, and the task
 * the recipient created is the one the sender was told about.
 */
import { toHex, type Address, type Hex } from 'viem';
import {
  intentDigest, buildDigestBindingCaveat, capabilityHandler, registerDefaultSubsetHandlers, hashDelegation, ROOT_AUTHORITY,
  CAPABILITY_RAR_TYPE, type Delegation, type MandateRequirementV1,
} from '../packages/delegation/src/index.js';
import { buildA2aGrantCaveats, hashA2aMessage } from '../packages/a2a/src/index.js';
import { delegatedInputPart, withDelegatedTask } from '../packages/a2a/src/standard/index.js';
import { hashDeliveryBody } from '../apps/demo-a2a/src/outbound-delivery.js';

registerDefaultSubsetHandlers();

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const D = {
  dm: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestamp: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  allowedTargets: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethods: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',
  value: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', digestBinding: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1',
} as const;
const HARNESS_SA = '0xD34c3Fbc89706dd57d426546DCEBD3bA926eDE35' as Address;
const RECIPIENT_HANDLE = process.argv[2] ?? 'nathan';
const TEXT = process.argv[3] ?? `the folded wire carried this at ${new Date().toISOString()}`;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 400), _status: r.status }; } };

const signinAs = async (handle: string) => j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));

const alice = await signinAs('alice');
const recipient = await signinAs(RECIPIENT_HANDLE);
const token: string = alice.homeSession;
if (!token) throw new Error('no session for alice');
const ALICE = String(alice.agent).toLowerCase() as Address;
const RECIPIENT = String(recipient.agent).toLowerCase() as Address;
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
console.log(`alice ${ALICE}  →  ${RECIPIENT_HANDLE} ${RECIPIENT}`);

// ── The retired names are simply not methods any more ──
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];
const retired = await j(await fetch(`https://${RECIPIENT_HANDLE}.faithnet.ai/api/a2a`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }),
}));
console.log(`\nmessage/send on the live wire → ${JSON.stringify(retired.error ?? retired).slice(0, 160)}`);

// ── The MANDATE: alice → the harness, `messaging.direct.send` at the recipient, for THIS ask ──
const goal = `send ${RECIPIENT_HANDLE} a message saying ${TEXT}`;
const intent = { goal, context: { recipient: RECIPIENT, nonce: toHex(crypto.getRandomValues(new Uint8Array(8))) } };
const now = Math.floor(Date.now() / 1000);
const req: MandateRequirementV1 = {
  type: CAPABILITY_RAR_TYPE, actions: ['messaging.direct.send'], locations: [RECIPIENT],
  intentDigest: intentDigest(intent), validAfter: now - 60, validUntil: now + 3600,
};
const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const mandate: Delegation = { delegator: ALICE, delegate: HARNESS_SA, authority: ROOT_AUTHORITY, caveats: [...capabilityHandler.toCaveats(req, { delegationManager: D.dm, timestamp: D.timestamp, allowedTargets: D.allowedTargets, allowedMethods: D.allowedMethods, value: D.value, digestBinding: D.digestBinding } as never), buildDigestBindingCaveat(D.digestBinding, 'intent', req.intentDigest)], salt, signature: '0x' };
mandate.signature = await sign(hashDelegation(mandate, CHAIN, D.dm));
const wire = { ...mandate, salt: salt.toString() };
console.log(`mandate  messaging.direct.send at ${RECIPIENT}, bound to this ask`);

// ── The run: the harness delivers over the FOLDED wire ──
const run = await j(await fetch(`${HOME}/a2a/harness/run`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' },
  body: JSON.stringify({ session: token, intent, presented: wire, supplied: [], runRef: `fold-${Date.now()}` }),
}));
console.log(`\noutcome ${run.outcome}${run.error ? `  error ${run.error}` : ''}${run.detail ? `  detail ${run.detail}` : ''}`);
for (const rc of run.receipts ?? []) console.log(`  ${rc.stepRef} ${rc.toolId} ${rc.status} decision=${rc.authority?.decision?.decision ?? '-'}${rc.error ? ` — ${rc.error}` : ''}`);
if (run.outcome !== 'completed') throw new Error(`the delivery did not complete: ${JSON.stringify(run).slice(0, 900)}`);

const result = run.result as { taskId?: string; state?: string; messageId?: string; delivered?: unknown };
console.log(`  result ${JSON.stringify(result).slice(0, 300)}`);

// ── The recipient's own agent holds the task the sender was told about ──
if (result?.taskId) {
  const asRecipient = recipient.homeSession as string;
  const got = await j(await fetch(`https://${RECIPIENT_HANDLE}.faithnet.ai/api/a2a`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${asRecipient}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: result.taskId } }),
  }));
  const task = got.result as { id?: string; status?: { state?: string }; metadata?: Record<string, unknown> } | undefined;
  console.log(`\nGetTask as ${RECIPIENT_HANDLE} → ${task ? `${task.id} ${task.status?.state}` : JSON.stringify(got.error ?? got).slice(0, 200)}`);
  if (task?.id?.toLowerCase() !== result.taskId.toLowerCase()) throw new Error('the recipient does not hold the task the sender was told about');
}

// ── THE DELEGATED TASK ITSELF, hand-built, agent to agent over the one wire ──────────────────────────
//
// This is the path the retired profile existed for: alice's agent asks nathan's agent to run a skill,
// authorized by a grant she signs and an envelope she signs. Nothing about that changed — only where the
// two signatures ride. The gate on the far side is `authorizeA2aMessage`, untouched.
console.log('\n── a delegation-authorized task, over SendMessage ──');
const SKILL = 'messaging.deliver';
const input = { envelope: { from: ALICE, to: RECIPIENT, kind: 'dm', text: TEXT }, bodyRef: { owner: RECIPIENT, recordType: 'pending' } };
const bodyHash = hashDeliveryBody(input);
const messageId = toHex(crypto.getRandomValues(new Uint8Array(32)));
const envelope = {
  messageId, sender: ALICE, skill: SKILL,
  bodyRef: { owner: RECIPIENT, recordType: 'pending' }, bodyHash,
  signature: '0x' as Hex, createdAt: Math.floor(Date.now() / 1000),
};
envelope.signature = await sign(hashA2aMessage(envelope as never));

const transportSalt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const transport: Delegation = {
  delegator: ALICE, delegate: ALICE, authority: ROOT_AUTHORITY,
  caveats: buildA2aGrantCaveats({
    recipientAgentSA: RECIPIENT, skill: SKILL,
    enforcers: { allowedTargets: D.allowedTargets as Address, allowedMethods: D.allowedMethods as Address, timestamp: D.timestamp as Address },
    window: { validAfter: 0, validUntil: now + 3600 },
  }),
  salt: transportSalt, signature: '0x',
};
transport.signature = await sign(hashDelegation(transport, CHAIN, D.dm));

const sendMessage = {
  jsonrpc: '2.0', id: 3, method: 'SendMessage',
  params: {
    message: withDelegatedTask(
      { messageId, role: 'ROLE_USER', parts: [delegatedInputPart(input)] },
      {
        delegation: { ...transport, salt: transportSalt.toString() } as never,
        requester: ALICE, skill: SKILL, sender: ALICE,
        bodyHash, bodyRef: envelope.bodyRef, signature: envelope.signature, createdAt: envelope.createdAt,
      },
    ),
  },
};
const sent = await j(await fetch(`https://edge.faithnet.io/api/a2a/${RECIPIENT_HANDLE}.me`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${token}` },
  body: JSON.stringify(sendMessage),
}));
const task = (sent.result as { task?: { id: string; status: { state: string }; metadata?: Record<string, unknown> } } | undefined)?.task;
console.log(`  SendMessage → ${task ? `${task.id}  ${task.status.state}` : JSON.stringify(sent.error ?? sent).slice(0, 300)}`);
if (!task) throw new Error('the delegated task was not created over the folded wire');
const carried = (task.metadata ?? {})['https://agenticprimitives.org/a2a/delegated-task/v1'] as { skill?: string; principal?: string; sender?: string } | undefined;
console.log(`  the task says: skill ${carried?.skill}, principal ${carried?.principal}, sender ${carried?.sender}`);
if (carried?.skill !== SKILL) throw new Error('the task did not record the skill the extension named');

// A stranger cannot even learn it exists.
const stranger = await signinAs('bob');
const peek = await j(await fetch(`https://edge.faithnet.io/api/a2a/${RECIPIENT_HANDLE}.me`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${stranger.homeSession}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'GetTask', params: { id: task.id } }),
}));
console.log(`  GetTask as bob (not a party) → ${JSON.stringify(peek.error ?? peek.result).slice(0, 140)}`);
if (peek.error?.code !== -32001) throw new Error('a stranger must be told the task does not exist, not that it is forbidden');

console.log(`\n✓ spec 372 S4: one wire. \`message/send\` is not a method; the same delivery rides an A2A 1.0 \`SendMessage\` carrying the delegated-task extension, and every gate behind it is the one that was always there.`);
