// THE HARNESS ON THIS AGENT — spec 350 W2: a treasury payment (scenario 3) and a team's creation
// (scenario 2) under a mandate.
//
// This is where the harness stops being a package and becomes a thing that moves money. `runIntent` asks
// its ports before every capability step; this module binds those ports to this Worker's substrate:
//
//   MandateVerifier  → `delegation.verifyMandateForStep` over the chain (isRevoked, ERC-1271 via the
//                      UniversalSignatureValidator — readContract only, ADR-0012)
//   PolicyEvaluator  → tool-policy's risk ladder: `treasury.payment.execute` is HIGH ⇒ a second party
//   ApprovalPort     → supplied approvals (W2): the steward pre-signs an approval over the STEP'S authority
//                      evidence and hands it in with the ask; verified ERC-1271 against the approver SA.
//                      W3 makes this durable (suspend / resume through A2aTaskDO).
//   ReceiptSink      → the audit sink + the response. Vault-resident receipts are W3.
//   ToolInvoker      → `organization.team.create` does what the Home's button does, conversationally: it
//                      builds the team's GENESIS (deploy + `<label>.team` + typed declaration + the
//                      stewardship grant child → workspace, one sponsored userOp) and ASKS the connected
//                      user for what only they hold — the name if the ask did not say it, the credential
//                      that will custody the team (custody is ALWAYS the connected user), and the
//                      signature over the genesis hash. On resume it re-derives the genesis and checks the
//                      signed userOp IS the one it derived before submitting. The mandate (delegator = the
//                      workspace) is what lets this agent act in the workspace's name; the custodian's
//                      signature is what brings the team into being. Neither substitutes for the other.
//                    → `treasury.payment.execute` REDEEMS the mandate on chain: this agent's service SA
//                      submits `DelegationManager.redeemDelegation(mandate, USDC, 0, transfer(payee, amt))`
//                      as a sponsored userOp, with the PaymentEnforcer's redeem-time args AND the
//                      DigestBindingEnforcer's presented intent digest filled in. The delegator is the
//                      PAYER — an org or its treasury SA — and it is the delegator's USDC that moves.
//
// WHO IS THE DELEGATE. The mandate names THIS agent's harness SA (`HARNESS_AGENT_SA`) as delegate,
// custodied by the interactions-session key. `DelegationManager` requires `msg.sender == delegate`, so
// the service SA executes `execute(DM, 0, redeem…)` and the DM calls back into the payer SA. No key for
// the payer is ever held here; the mandate is the only authority, and it is checked per step, on chain
// AND off.
import { encodeAbiParameters, encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import {
  runIntent, InputRequired, dataFor, signatureFor,
  type RunResult, type ToolSpec, type ToolInvoker, type ApprovalPort, type ReceiptSink, type StepReceipt, type MandatePresentation, type SuppliedInputV1, type InputFieldV1, type AnswerComposer,
} from '@agenticprimitives/orchestration';
import { delegationMandateVerifier, riskLadderPolicy, mandateRequirementForStep } from '@agenticprimitives/harness';
import {
  hashDelegation, intentDigest, encodeDigestBindingArgs, decodeTimestampTerms, buildCaveat, buildVaultRecordScopeCaveat,
  encodeTimestampTerms, encodeValueTerms, ROOT_AUTHORITY, CAPABILITY_RAR_TYPE, PAYMENT_RAR_TYPE,
  type Caveat, type Delegation, type EnforcerAddresses, type MandateRequirementV1,
} from '@agenticprimitives/delegation';
import { universalSignatureValidatorAbi } from '@agenticprimitives/chain-state-viem';
import type { AuditSink } from '@agenticprimitives/audit';
import { enforcersFromEnv } from './org-wire.js';
import { wireToDelegation, type DelegationWireV1 } from '@agenticprimitives/a2a';
import { selectPlanner, selectComposer } from './orchestration.js';
import { ASK_DISCOVERY_TOOLS } from './ask-discovery.js';


export interface HarnessEnv {
  CHAIN_ID: string;
  RPC_URL?: string;
  DELEGATION_MANAGER: string;
  UNIVERSAL_SIGNATURE_VALIDATOR?: string;
  /** The SA this agent acts as under a mandate (the mandate's DELEGATE). Deployed per chain, custodied by the
   *  interactions-session key. Not INTERACTIONS_SERVICE_SA: that address is what existing grants name. */
  HARNESS_AGENT_SA?: string;
  DIGEST_BINDING_ENFORCER?: string;
  PAYMENT_ENFORCER?: string;
  MOCK_USDC?: string;
  [k: string]: unknown;
}

/** The action tools this agent exposes to the harness, WITH their capability declarations. Risk and
 *  capability are declared on the tool — the planner cannot describe a step out of needing authority. */
/** The child agents an Ask can charter, and the typed root each lands under (spec 346). One shape, one
 *  ceremony: what differs is the capability the mandate must grant and whose authority it needs — a team
 *  needs its workspace's, an organization needs the PERSON's (nothing above them exists yet, which is
 *  exactly why org-create belongs to the person's own realm). */
export const CHILD_AGENT_KINDS = [
  { capability: 'organization.team.create', tld: 'team', noun: 'team', parentNoun: 'a workspace or organization' },
  { capability: 'organization.create', tld: 'org', noun: 'organization', parentNoun: 'a person (their own realm)' },
  { capability: 'treasury.create', tld: 'treasury', noun: 'treasury', parentNoun: 'a person or an organization' },
] as const;

/** The KIND a created agent is recorded as in its owner's tree. Usually the noun; a treasury is named for
 *  WHOSE it is, because that is how the Home lists it (`person-treasury` under you, `org-treasury` inside
 *  the organization) — recording a bare "treasury" would put it in neither. */
export function recordedKind(noun: string, parent: string, person?: string): string {
  if (noun !== 'treasury') return noun;
  return person && parent.toLowerCase() === person.toLowerCase() ? 'person-treasury' : 'org-treasury';
}

export const CHILD_AGENT_TLD: Record<string, string> = Object.fromEntries(CHILD_AGENT_KINDS.map((k) => [k.capability, k.tld]));

/**
 * `organization.membership.invite` — the org-side half of joining (spec 321 W2b).
 *
 * Membership is not something an organization can impose: the invitee redeems it. So the capability an
 * organization grants is the INVITATION, and what it produces is a pre-signed org → invitee access grant
 * that the invitee's join picks up. The steward's credential signs it (the org validates its custodians'
 * signatures, ERC-1271), which is a §3.5 signature prompt like any other.
 *
 * The private half — storing the grant in the ORG's vault — is the surface's, exactly as recording a
 * created agent is: this agent holds no delegation to that vault, and an invitation nobody stored is a
 * promise nobody can find.
 */
export const ORG_INVITE_CAPABILITY = 'organization.membership.invite' as const;

export const INVITE_TOOL: ToolSpec = {
  id: ORG_INVITE_CAPABILITY,
  description:
    'Invite an agent to join an organization or team as a member. Requires a mandate from the organization. '
    + 'Produces a signed access grant the invitee redeems when they join — it does NOT make them a member by itself. '
    + 'Args: org (the organization or team SA — whose authority this needs), invitee (the person\'s SA address; '
    + 'use the directory tools first when the ask names someone rather than an address).',
  inputSchema: {
    type: 'object',
    properties: {
      org: { type: 'string', description: 'The organization or team SA address' },
      invitee: { type: 'string', description: 'The invitee\'s smart-agent address (0x…)' },
    },
    required: ['org', 'invitee'],
  },
  capability: { id: ORG_INVITE_CAPABILITY, action: 'invite', resourceArg: 'org', authorityArg: 'org' },
  risk: 'medium',
};

export const HARNESS_ACTION_TOOLS: ToolSpec[] = [
  {
    id: 'treasury.payment.execute',
    description: 'Pay an ERC-20 amount from one treasury (or organization) to another. Requires a payment mandate from the PAYER. Args: payer (the paying treasury/org SA — whose authority this needs), asset (token address), payee (recipient SA), amount (smallest units as a decimal string; USDC has 6 decimals, so 100 USDC is "100000000").',
    inputSchema: {
      type: 'object',
      properties: {
        payer: { type: 'string', description: 'The paying treasury or organization SA address' },
        asset: { type: 'string', description: 'ERC-20 token contract address' },
        payee: { type: 'string', description: 'Recipient address, or its agent name (e.g. bob.me)' },
        amount: { type: 'string', description: 'Amount in the token\'s smallest unit, as a decimal string' },
      },
      required: ['payer', 'asset', 'payee', 'amount'],
    },
    // The step ACTS ON the token and needs the PAYER's authority. Conflating them asks a person to grant
    // authority as an ERC-20 contract, which nothing can sign.
    capability: { id: 'treasury.payment.execute', action: 'execute', resourceArg: 'asset', authorityArg: 'payer' },
    risk: 'high',
  },
  INVITE_TOOL,
  {
    id: 'treasury.fund',
    description:
      'Fund a treasury with DEMO USDC (a faucet mint, not a transfer — no one is debited). Requires a '
      + 'mandate from the funder, because the mint is made in their name. Args: funder (the SA whose '
      + 'authority this needs — normally the person asking), treasury (its ADDRESS or its NAME, e.g. '
      + '"alice2.treasury" — either works), amount (smallest units as a decimal string — USDC has 6 '
      + 'decimals, so 12.11 USDC is "12110000"). Use this whenever the ask is to fund, top up or add '
      + 'demo USDC to a treasury: it takes the name directly, so no lookup is needed first.',
    inputSchema: {
      type: 'object',
      properties: {
        funder: { type: 'string', description: 'The funding SA (whose authority this needs)' },
        asset: { type: 'string', description: 'The demo USDC contract address (ask the agent if unknown)' },
        treasury: { type: 'string', description: 'The treasury SA to credit' },
        amount: { type: 'string', description: 'Amount in the token\'s SMALLEST units (12.11 USDC = "12110000"). Use `usdc` instead if the ask says a decimal figure.' },
        usdc: { type: 'string', description: 'Amount in whole USDC as the person said it, e.g. "12.11". Use this when the ask names a decimal figure — do not convert it yourself.' },
      },
      // `funder` is OPTIONAL on purpose. The planner chooses ONE tool (that is what the planner IS), so a
      // capability whose required args it cannot fill from the sentence is a capability it will not
      // choose — it picked the lookup and answered instead. Whose authority this needs is not the
      // planner's to decide anyway: it is the mandate's delegator, and the surface asks the person
      // standing in that realm.
      // Either unit, never a guess. "fund alice2.treasury with 12.11 USDC" made the planner hesitate over
      // a field asking for 12110000 and answer with a paragraph instead; two differently-named arguments
      // remove the ambiguity rather than resolving it silently, which is the only acceptable way to be
      // unsure about an amount of money.
      required: ['treasury'],
    },
    // It acts on the TOKEN and needs the FUNDER's authority — the same split a payment has.
    capability: { id: 'treasury.fund', action: 'fund', resourceArg: 'asset', authorityArg: 'funder' },
    risk: 'low',
  },
  ...CHILD_AGENT_KINDS.map(({ capability, tld, noun, parentNoun }): ToolSpec => ({
    id: capability,
    description:
      `Create (charter) a new ${noun.toUpperCase()} under ${parentNoun}. It becomes a typed agent named <label>.${tld}, `
      + `custodied by the connected user and stewarded by its parent. Requires a mandate from the parent. `
      + `Args: parent (the parent SA address — the mandate's delegator), label (the ${noun}'s name: lowercase letters, `
      + `digits, hyphens; omit if the ask did not name it — the person will be asked). `
      // These tools are NOT interchangeable and the planner must not treat them as a menu of near-misses:
      // asked for a treasury with no treasury tool, it picked organization.create and chartered an
      // organization the person then could not find where they looked for it (2026-09-04).
      + `ONLY for a ${noun}: a team, an organization, a treasury and a service are different kinds of agent, `
      + `and each has its own tool. If the ask names a kind that has no tool here, say so — never charter the nearest one.`,
    inputSchema: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: `The ${parentNoun} SA address` },
        label: { type: 'string', description: `The ${noun} name label (a-z, 0-9, hyphen). Omit when the ask did not say it.` },
      },
      required: ['parent'],
    },
    capability: { id: capability, action: 'create', resourceArg: 'parent' },
    risk: 'medium',
  })),
];

// ─── organization.team.create — the genesis a connected user signs ────────────────────────────────────

/** The connected user's credential, as the Ask surface describes it (a `credential` field answer). */
export type CredentialV1 =
  | { kind: 'eoa'; address: Address }
  | { kind: 'passkey'; credentialIdDigest: Hex; pubKeyX: string; pubKeyY: string; rpIdHash: Hex };

/** A packed userOp as it travels (bigints as decimal strings) — the /session/deploy wire shape. */
export interface GenesisUserOpJson {
  sender: Address; nonce: string; initCode: Hex; callData: Hex; accountGasLimits: Hex; preVerificationGas: string; gasFees: Hex; paymasterAndData: Hex; signature: Hex;
}

export const CHILD_LABEL_PATTERN = '^[a-z0-9-]{3,63}$';

/** What the Worker supplies for a team's genesis — the substrate the Home ceremony already uses, behind a
 *  port so the protocol (ask → derive → check → submit) is testable without a chain. */
export interface TeamGenesisDeps {
  /** Does `credential` custody `person`? A chain read on the person's SA (isCustodian / hasPasskey). */
  isCustodianOf(person: Address, credential: CredentialV1): Promise<boolean>;
  /** Who `<label>.team` resolves to, if anyone. */
  resolveName(name: string): Promise<Address | null>;
  /** Predict the child and build its genesis userOp: initCode from (credential, salt); callData = declare
   *  type + register `<label>.<tld>` + set primary + approve the stewardship digest (child → parent). */
  build(input: { credential: CredentialV1; salt: bigint; label: string; tld: string; parent: Address; stewardship: { salt: bigint; validUntil: number } }): Promise<{ child: Address; name: string; userOp: GenesisUserOpJson; userOpHash: Hex; stewardship: DelegationWireV1 }>;
  /** The EntryPoint's hash of an arbitrary userOp (readContract). */
  userOpHash(userOp: GenesisUserOpJson): Promise<Hex>;
  /** Has the child already been deployed? (a resume after success is a no-op) */
  isDeployed(child: Address): Promise<boolean>;
  /** Submit the signed genesis, sponsored. Throws on an inner revert. */
  submit(userOp: GenesisUserOpJson): Promise<{ txHash: Hex }>;
}

function parseCredential(v: unknown): CredentialV1 | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (c.kind === 'eoa' && typeof c.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.address)) return { kind: 'eoa', address: c.address.toLowerCase() as Address };
  if (c.kind === 'passkey' && typeof c.credentialIdDigest === 'string' && typeof c.pubKeyX === 'string' && typeof c.pubKeyY === 'string' && typeof c.rpIdHash === 'string') {
    return { kind: 'passkey', credentialIdDigest: c.credentialIdDigest as Hex, pubKeyX: c.pubKeyX, pubKeyY: c.pubKeyY, rpIdHash: c.rpIdHash as Hex };
  }
  return null;
}

/** Who must sign the genesis — the credential's address, or the passkey by its credential id. */
const signerOf = (c: CredentialV1): string => (c.kind === 'eoa' ? c.address : `passkey:${c.credentialIdDigest}`);

/**
 * The child-agent-create invoker (team, organization — same ceremony, different typed root). Reads the ask
 * (args) and the answers (ctx.supplied); asks for what is missing; derives the genesis deterministically
 * from the intent so a resume rebuilds the same child; and on a signed resume checks the signed userOp
 * against what it derived — sender, initCode, callData, hash — before submitting. `person` is the connected
 * user (from the session): the credential MUST custody them, because what you create, you custody.
 */
export function childAgentCreateInvoker(genesis: TeamGenesisDeps, env: HarnessEnv, presented: MandatePresentation, person: Address | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const wire = presented.wire as Delegation;
    const tld = CHILD_AGENT_TLD[toolId];
    const noun = CHILD_AGENT_KINDS.find((k) => k.capability === toolId)?.noun ?? 'agent';
    const aNoun = `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;
    if (!tld) throw new Error(`${toolId} is not a child-agent capability`);
    const parent = String(args.parent ?? '').toLowerCase() as Address;
    if (parent !== wire.delegator.toLowerCase()) throw new Error(`the ${noun} is chartered by the mandate's delegator (${wire.delegator}); the plan named ${parent || 'no parent'}`);
    if (!person) throw new Error(`no connected user: ${aNoun} is custodied by the connected user, and there is none on this run`);

    const data = dataFor(ctx.supplied, stepRef);
    const rawLabel = String(data.label ?? args.label ?? '').trim().toLowerCase();
    const label = new RegExp(CHILD_LABEL_PATTERN).test(rawLabel) ? rawLabel : '';
    const credential = parseCredential(data.custodian);
    const ask = (fields: InputFieldV1[], prompt: string): never => {
      throw new InputRequired({ kind: 'data', stepRef, toolId, prompt, fields });
    };
    const labelField = (hint?: string): InputFieldV1 => ({ name: 'label', label: `${noun[0]!.toUpperCase()}${noun.slice(1)} name`, type: 'text', required: true, pattern: CHILD_LABEL_PATTERN, ...(hint ? { hint } : { hint: `lowercase letters, digits and hyphens; becomes <name>.${tld}` }) });
    const credentialField: InputFieldV1 = { name: 'custodian', label: 'Connected credential', type: 'credential', required: true, hint: `the credential you are signed in with will custody the ${noun}` };
    if (!label || !credential) {
      const fields: InputFieldV1[] = [...(label ? [] : [labelField(rawLabel ? `"${rawLabel}" is not a valid ${noun} name` : undefined)]), ...(credential ? [] : [credentialField])];
      ask(fields, label ? `Which credential will custody the ${noun}?` : `What should the ${noun} be called?`);
    }
    const name = `${label}.${tld}`;
    if (!(await genesis.isCustodianOf(person, credential!))) throw new Error(`the supplied credential does not custody the connected user's agent ${person} — custody is always the connected user`);

    // Deterministic from the intent: the same ask derives the same child, so a resume rebuilds what was
    // signed, and a second identical ask finds the team already there instead of chartering a twin.
    const digest = intentDigest(ctx.intent);
    const salt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:${tld}`)));
    const stewardshipSalt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:stewardship`)));
    // The stewardship grant's window starts where the mandate's does (a fixed point per mandate), so it too
    // is the same on every run of this ask.
    const enforcers = harnessEnforcers(env);
    const ts = wire.caveats.find((c) => c.enforcer.toLowerCase() === enforcers.timestamp.toLowerCase());
    if (!ts) throw new Error('the mandate carries no timestamp caveat');
    const validUntil = Number(decodeTimestampTerms(ts.terms as Hex).validAfter) + 365 * 24 * 3600;

    const g = await genesis.build({ credential: credential!, salt, label, tld, parent, stewardship: { salt: stewardshipSalt, validUntil } });
    if (await genesis.isDeployed(g.child)) {
      return { agent: g.child, name: g.name, kind: recordedKind(noun, parent, person), parent, custodian: credential, person, stewardshipDelegation: g.stewardship, alreadyCreated: true };
    }
    // Taken by someone ELSE — the child this ask derives is not there yet, so the name is not ours.
    const holder = await genesis.resolveName(name);
    if (holder && holder.toLowerCase() !== g.child.toLowerCase()) ask([labelField(`${name} is already taken — pick another name`)], `${name} is already taken. What should the ${noun} be called instead?`);

    const signed = signatureFor(ctx.supplied, stepRef);
    if (!signed) {
      throw new InputRequired({
        kind: 'signature', stepRef, toolId,
        prompt: `Sign the genesis of ${g.name} — ${aNoun} under ${parent}, custodied by you.`,
        digest: g.userOpHash, signer: signerOf(credential!),
        payload: { child: g.child, name: g.name, parent, userOp: g.userOp },
      });
    }
    // What was signed must be what this run derives. The paymaster window and gas may differ between the
    // build that was signed and this one, so the comparison is on what the genesis MEANS — sender, initCode
    // (credential + salt), callData (name, type, stewardship) — and the hash the EntryPoint computes over
    // the supplied op must be the digest the credential signed.
    const op = (signed.payload as { userOp?: GenesisUserOpJson } | undefined)?.userOp;
    if (!op) throw new Error('the signature answer carries no userOp payload');
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (!same(op.sender, g.child) || !same(op.initCode, g.userOp.initCode) || !same(op.callData, g.userOp.callData)) {
      throw new Error(`the signed genesis is not the one this ask derives (sender/initCode/callData differ) — refusing to submit`);
    }
    const hash = await genesis.userOpHash(op);
    if (!same(hash, signed.digest)) throw new Error(`the signed digest ${signed.digest} is not the hash of the supplied userOp (${hash})`);
    if (signed.signer.toLowerCase() !== signerOf(credential!).toLowerCase()) throw new Error(`the signature is not from the credential that will custody the ${noun}`);
    const { txHash } = await genesis.submit({ ...op, signature: signed.signature as Hex });
    return { txHash, agent: g.child, name: g.name, kind: recordedKind(noun, parent, person), parent, custodian: credential, person, stewardshipDelegation: g.stewardship };
  };
}

const IS_REVOKED_ABI = [{ type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [{ name: 'delegationHash', type: 'bytes32' }], outputs: [{ type: 'bool' }] }] as const;
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;
const TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const REDEEM_ABI = [{
  type: 'function', name: 'redeemDelegation', stateMutability: 'nonpayable',
  inputs: [
    { name: 'delegations', type: 'tuple[]', components: [
      { name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' },
      { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] },
      { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' },
    ] },
    { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
  ],
  outputs: [],
}] as const;

/** What the Worker must supply: chain reads and the service SA's signing + submission. Injected so the
 *  module is testable without a Worker. */
export interface HarnessDeps {
  readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
  /** Build, sign (with the service SA's custodian) and submit a sponsored userOp from `sender`. */
  executeAsServiceSa: (sender: Address, callData: Hex) => Promise<{ txHash: Hex }>;
  audit: AuditSink;
  /** The team-genesis substrate; absent ⇒ `organization.team.create` fails as unconfigured (never silently). */
  teamGenesis?: TeamGenesisDeps;
  /** Resolve an agent NAME to its address, on chain. Injected so a capability can take "alice2.treasury"
   *  where it needs an address: asking a planner to chain a lookup into a later step's args is a
   *  coordination problem we do not need to have, and it answered with a paragraph instead of acting. */
  resolveName?: (name: string) => Promise<string | null>;
  now?: () => number;
}

export function harnessEnforcers(env: HarnessEnv): EnforcerAddresses {
  const base = enforcersFromEnv(env as Record<string, string | undefined>);
  const db = (env.DIGEST_BINDING_ENFORCER ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(db)) throw new Error('harness: DIGEST_BINDING_ENFORCER is not configured — a mandate cannot be verified without it (no fallback)');
  return { ...base, digestBinding: db as Address };
}

/** A steward's approval of ONE step, signed over the canonical approval digest. */
export interface SuppliedApprovalV1 {
  approver: Address;
  /** keccak256(JCS({ runRef?, stepRef, mandateRef, intentDigest, capability, action, resource })) — the
   *  step's authority evidence, so an approval cannot be reused for a different step. */
  digest: Hex;
  signature: Hex;
}

export function approvalDigestFor(input: { stepRef: string; mandateRef: string; intentDigest: string; capability: string; action: string; resource?: string }): Hex {
  // Addresses are normalised: the planner returns whatever case the model chose, the approver signs
  // whatever case its tooling produced, and a digest that differs by case is a refusal nobody intended.
  const norm = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v ?? null);
  const canonical = JSON.stringify({ action: input.action, capability: input.capability, intentDigest: input.intentDigest.toLowerCase(), mandateRef: input.mandateRef.toLowerCase(), resource: norm(input.resource), stepRef: input.stepRef });
  return keccak256(toBytes(canonical));
}

/**
 * The approval port. An approval is a signature over THIS step's authority evidence, verified ERC-1271
 * against the approver, from a party the obligation names — all three, or it is not an approval.
 *
 * Approvals reach it two ways, and they are the same signature either way: pre-supplied with the ask
 * (`approvals`, how a script drives it), or SIGNED IN THE CONVERSATION — when nothing is supplied yet, the
 * port asks (spec 350 §3.5) rather than refusing an obligation nobody was given the chance to discharge.
 *
 * The asking is not a softening of the ladder. The digest is the same, the ERC-1271 check is the same, and
 * a signature over anything else discharges nothing. What changes is only that a person present at the run
 * can answer it, which is what "a second party approves" means when the second party is standing there.
 */
export function suppliedApprovalsPort(deps: HarnessDeps, env: HarnessEnv, approvals: SuppliedApprovalV1[], supplied?: SuppliedInputV1[]): ApprovalPort {
  const validator = env.UNIVERSAL_SIGNATURE_VALIDATOR as Address | undefined;
  return {
    async request(req) {
      const want = approvalDigestFor({ stepRef: req.stepRef, mandateRef: req.evidence.mandateRef, intentDigest: req.evidence.intentDigest, capability: req.step.capability.id, action: req.step.capability.action, ...(req.step.capability.resource ? { resource: req.step.capability.resource } : {}) });
      // A signature answered into THIS step counts as an approval when it is over the approval digest.
      const answered = (supplied ?? [])
        .filter((s) => s.stepRef === req.stepRef && s.signature && s.signature.digest.toLowerCase() === want.toLowerCase())
        .map((s) => ({ approver: s.signature!.signer as Address, digest: s.signature!.digest as Hex, signature: s.signature!.signature as Hex }));
      const pool = [...approvals, ...answered];
      const records: string[] = [];
      for (const ob of req.obligations) {
        const allowed = (ob.dischargeableBy.agents ?? []).map((a) => a.toLowerCase());
        const candidates = pool.filter((a) => a.digest.toLowerCase() === want.toLowerCase() && (allowed.length === 0 || allowed.includes(a.approver.toLowerCase())));
        let discharged = false;
        let sawInvalid = false;
        for (const a of candidates) {
          if (!validator) break;
          const ok = await deps.readContract({ address: validator, abi: universalSignatureValidatorAbi, functionName: 'isValidSig', args: [a.approver, a.digest, a.signature] }).catch(() => false);
          if (ok === true) { records.push(`approval:${a.approver.toLowerCase()}:${a.digest}`); discharged = true; break; }
          sawInvalid = true;
        }
        if (discharged) continue;
        // A signature was offered and did not verify: that is a refusal, not a question to ask again.
        if (sawInvalid) return { status: 'refused', reason: `obligation ${ob.kind} (${ob.imposedBy}) not discharged: the approval did not verify against its approver` };
        return {
          status: 'pending', resumeToken: req.stepRef,
          prompt: {
            kind: 'signature', stepRef: req.stepRef, toolId: req.step.tool.id,
            prompt: `This needs a second party to approve it. Sign to approve ${req.step.capability.id}${req.step.capability.resource ? ` on ${req.step.capability.resource}` : ''}.`,
            digest: want, signer: allowed[0] ?? '',
            payload: { obligation: ob.kind, imposedBy: ob.imposedBy, mandateRef: req.evidence.mandateRef, capability: req.step.capability.id },
          },
        };
      }
      return { status: 'discharged', records };
    },
  };
}

/** The MCP server whose vault scope an org→member access grant names. Must match the Home's
 *  `MCP_SERVER_ID`, or the grant reads as scoped to a server nobody consults. */
const MCP_SERVER_ID = 'demo-mcp';
/** spec 322 W3 — the org record a member may read once they join. */
const ORG_PROFILE_RESOURCE_SCOPE = 'vault:org.profile';

/**
 * Build the org → invitee access grant this invitation carries — the SAME shape the Home's invite panel
 * signs (`issueOrganizationResourceAccessDelegation`): read scope on the org's profile record, time-bounded,
 * value 0. Deterministic in its salt and window so a resume rebuilds exactly what was signed.
 */
function buildInviteGrant(env: HarnessEnv, org: Address, invitee: Address, salt: bigint, validUntil: number): Delegation {
  const enforcers = harnessEnforcers(env);
  const caveats: Caveat[] = [
    buildVaultRecordScopeCaveat([{ server: MCP_SERVER_ID, resources: [ORG_PROFILE_RESOURCE_SCOPE], ops: ['read'] }]),
    buildCaveat(enforcers.timestamp, encodeTimestampTerms(0, validUntil)),
    buildCaveat(enforcers.value, encodeValueTerms(0n)),
  ];
  return { delegator: org, delegate: invitee, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
}

/**
 * `organization.membership.invite`. Derives the grant, asks the steward to sign it, and returns it for the
 * surface to store in the org's vault. It does NOT make anyone a member: the invitee redeems it on join,
 * which is the whole reason the org-side capability is the INVITATION and not the membership.
 */
export function inviteInvoker(env: HarnessEnv, presented: MandatePresentation, person: Address | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const wire = presented.wire as Delegation;
    const org = String(args.org ?? '').toLowerCase() as Address;
    const invitee = String(args.invitee ?? '').toLowerCase() as Address;
    if (org !== wire.delegator.toLowerCase()) throw new Error(`the invitation is issued by the mandate's delegator (${wire.delegator}); the plan named ${org || 'no organization'}`);
    if (!/^0x[0-9a-f]{40}$/.test(invitee)) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId, prompt: 'Who should be invited? Give their agent address.',
        fields: [{ name: 'invitee', label: 'Invitee', type: 'address', required: true, hint: 'their smart-agent address (0x…) — search the directory if you only have a name' }],
      });
    }
    if (invitee === org) throw new Error('an organization cannot invite itself');
    if (person && invitee === person.toLowerCase()) throw new Error('you are already the steward of this organization — an invitation to yourself grants nothing');

    const digest = intentDigest(ctx.intent);
    const chainId = Number(env.CHAIN_ID);
    const dm = env.DELEGATION_MANAGER as Address;
    const ts = wire.caveats.find((c) => c.enforcer.toLowerCase() === harnessEnforcers(env).timestamp.toLowerCase());
    if (!ts) throw new Error('the mandate carries no timestamp caveat');
    const validUntil = Number(decodeTimestampTerms(ts.terms as Hex).validAfter) + 365 * 24 * 3600;
    const salt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:invite:${invitee}`)));
    const grant = buildInviteGrant(env, org, invitee, salt, validUntil);
    const grantDigest = hashDelegation(grant, chainId, dm);

    const signed = signatureFor(ctx.supplied, stepRef, grantDigest);
    if (!signed) {
      throw new InputRequired({
        kind: 'signature', stepRef, toolId,
        prompt: `Sign the invitation from ${org} to ${invitee} — it lets them read this organization when they join.`,
        digest: grantDigest, signer: org,
        payload: { org, invitee, scope: ORG_PROFILE_RESOURCE_SCOPE, validUntil },
      });
    }
    // The invitation is the SIGNED grant. Storing it is the surface's half (the org's vault); returning
    // it unsigned-but-claimed would be an invitation that verifies nowhere.
    const wireOut: DelegationWireV1 = { ...grant, salt: salt.toString(), signature: signed.signature as Hex };
    return { org, invitee, memberAccessDelegation: wireOut, grantDigest, invited: true };
  };
}

/**
 * An address, or a NAME that resolves to one.
 *
 * People say "fund alice2.treasury", not "fund 0x5ef5…". Requiring an address here made the planner chain
 * a lookup into a later step's arguments, and when it did not it simply answered — reporting the address
 * it had found and that nothing had happened. A capability that accepts the words a person used needs no
 * such chain, and the resolution is the chain's own (immediate, unlike the directory).
 */
async function partyAddress(value: unknown, deps: HarnessDeps, what: string): Promise<Address> {
  const raw = String(value ?? '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase() as Address;
  if (!raw) throw new Error(`${what} is required`);
  if (!deps.resolveName) throw new Error(`${what} must be an address on this deployment (no name resolution wired)`);
  const resolved = await deps.resolveName(raw.toLowerCase());
  if (!resolved) throw new Error(`no agent holds the name "${raw}" — check it, or give the address`);
  return resolved.toLowerCase() as Address;
}

/** The amount, from whichever unit the ask used. Never inferred from a bare number: `amount` is smallest
 *  units, `usdc` is whole USDC, and neither one present is an error rather than a zero. */
export function fundingAmount(args: Record<string, unknown>): bigint {
  const raw = String(args.amount ?? '').trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) throw new Error(`amount must be whole smallest units (got "${raw}") — use the usdc argument for a decimal figure`);
    return BigInt(raw);
  }
  const human = String(args.usdc ?? '').trim();
  if (!human) throw new Error('how much? give `usdc` (e.g. "12.11") or `amount` in smallest units');
  if (!/^\d+(\.\d{1,6})?$/.test(human)) throw new Error(`"${human}" is not an amount of USDC (up to 6 decimal places)`);
  const [whole, frac = ''] = human.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }] as const;

/**
 * `treasury.fund` — the demo faucet, done in the FUNDER's name.
 *
 * The Home's Fund button has the person's own SA call `mint` on the demo token; through the Ask the same
 * call is made by this agent redeeming the funder's mandate, so the authority is explicit and the receipt
 * says whose it was. A mint credits without debiting anyone, which is why this is `low` risk and a payment
 * is `high` — the ladder should not demand a second party to hand out demo money.
 */
export function fundInvoker(deps: HarnessDeps, env: HarnessEnv, presented: MandatePresentation): ToolInvoker {
  return async (_toolId, args, ctx) => {
    const wire = presented.wire as Delegation;
    const serviceSa = (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    const dm = env.DELEGATION_MANAGER as Address;
    // The demo token is a DEPLOYMENT fact, not something to ask a planner to remember: default it, and
    // let an explicit arg override only if someone means a different token.
    const asset = (String(args.asset || env.MOCK_USDC || '')).toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(asset)) throw new Error('treasury.fund: no demo token is configured on this deployment');
    const funder = String(args.funder ?? '').toLowerCase();
    if (funder && funder !== wire.delegator.toLowerCase()) throw new Error(`the funding is made by the mandate's delegator (${wire.delegator}); the plan named ${funder}`);
    const treasury = await partyAddress(args.treasury, deps, 'the treasury to fund');
    const amount = fundingAmount(args);
    const digest = intentDigest(ctx.intent);
    const caveats = wire.caveats.map((c) => (c.enforcer.toLowerCase() === harnessEnforcers(env).digestBinding.toLowerCase()
      ? { enforcer: c.enforcer, terms: c.terms as Hex, args: encodeDigestBindingArgs(digest) }
      : { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex }));
    const mint = encodeFunctionData({ abi: MINT_ABI, functionName: 'mint', args: [treasury, amount] });
    const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [[{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }], asset, 0n, mint] });
    const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dm, 0n, redeem] });
    const { txHash } = await deps.executeAsServiceSa(serviceSa, callData);
    return { txHash, treasury, asset, amount: amount.toString(), funder: wire.delegator };
  };
}

/** The invoker: informational tools go to the existing MCP path; the payment tool redeems on chain; the
 *  team tool builds a genesis the connected user signs. */
export function harnessInvoker(deps: HarnessDeps, env: HarnessEnv, presented: MandatePresentation | null, mcpInvoke: ToolInvoker, person?: Address): ToolInvoker {
  return async (toolId, args, ctx) => {
    // Unreachable for a capability tool (the loop refuses or reports before invoking one without a
    // mandate); explicit so a future caller cannot make it reachable quietly.
    if (!presented && (CHILD_AGENT_TLD[toolId] || toolId === 'treasury.payment.execute' || toolId === 'treasury.fund' || toolId === ORG_INVITE_CAPABILITY)) throw new Error(`${toolId} requires a mandate and none was presented`);
    if (toolId === ORG_INVITE_CAPABILITY) return inviteInvoker(env, presented!, person)(toolId, args, ctx);
    if (CHILD_AGENT_TLD[toolId]) {
      if (!deps.teamGenesis) throw new Error(`${toolId} is not configured on this agent (no genesis substrate)`);
      return childAgentCreateInvoker(deps.teamGenesis, env, presented!, person)(toolId, args, ctx);
    }
    if (toolId === 'treasury.fund') return fundInvoker(deps, env, presented!)(toolId, args, ctx);
    if (toolId !== 'treasury.payment.execute') return mcpInvoke(toolId, args, ctx);
    const serviceSa = (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    const dm = env.DELEGATION_MANAGER as Address;
    const enforcers = harnessEnforcers(env);
    if (!enforcers.payment) throw new Error('harness: PAYMENT_ENFORCER is not configured');
    const asset = String(args.asset).toLowerCase() as Address;
    const payer = String(args.payer ?? '').toLowerCase();
    if (payer && payer !== (presented!.wire as Delegation).delegator.toLowerCase()) {
      throw new Error(`the payment is made by the mandate's delegator (${(presented!.wire as Delegation).delegator}); the plan named ${payer}`);
    }
    const payee = await partyAddress(args.payee, deps, 'the payee');
    const amount = BigInt(String(args.amount));
    const wire = presented!.wire as Delegation;
    const digest = intentDigest(ctx.intent);

    // Redeem-time caveat args. PaymentEnforcer: (mandateId, nonce, resourceHash) — the nonce is single-use
    // ON CHAIN, and it is derived from the INTENT and the step, never from the run. The first cut derived
    // it from the run's random ref, and the identical ask run twice paid twice: each run was a fresh nonce,
    // both were within the mandate's aggregate ceiling, and the chain saw two legitimate redemptions. An
    // intent is one thing that happens once; a second settlement needs a second intent (a new nonce in the
    // intent), not a second run. With the nonce bound to the intent, a replay reverts NonceReused on chain
    // whatever the run ref — the idempotency the loop asked for becomes an on-chain guarantee.
    // DigestBindingEnforcer: the intent digest this run is acting under — the commitment.
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const nonce = keccak256(toBytes(`${digest}:${stepRef}`));
    const paymentArgs = encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [digest, nonce, keccak256(toBytes(`${presented!.ref}:${stepRef}`))]);
    const caveats = wire.caveats.map((c) => {
      const e = c.enforcer.toLowerCase();
      if (e === enforcers.payment!.toLowerCase()) return { enforcer: c.enforcer, terms: c.terms as Hex, args: paymentArgs };
      if (e === enforcers.digestBinding.toLowerCase()) return { enforcer: c.enforcer, terms: c.terms as Hex, args: encodeDigestBindingArgs(digest) };
      return { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex };
    });
    const transfer = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [payee, amount] });
    const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [[{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }], asset, 0n, transfer] });
    const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dm, 0n, redeem] });
    const { txHash } = await deps.executeAsServiceSa(serviceSa, callData);
    return { txHash, asset, payee, amount: amount.toString(), payer: wire.delegator };
  };
}

export interface HarnessRunInput {
  intent: { goal: string; constraints?: Record<string, unknown>; context?: Record<string, unknown> };
  /** The mandate the caller presents. `null` is legitimate on an ASK: the run then reports the authority it
   *  would need (`authority-required`) instead of failing — and grants nothing. */
  presented: DelegationWireV1 | null;
  approvals?: SuppliedApprovalV1[];
  /** Spec 350 §3.4 — answers to the prompts an earlier run of this ask raised (a resume). */
  supplied?: SuppliedInputV1[];
  /** The connected user (the session's SA). What they create, they custody. */
  person?: Address;
  runRef?: string;
  /** The MCP-backed invoker for informational tools (the existing orchestrate path). */
  mcpInvoke: ToolInvoker;
}

/** Which RAR type bounds a capability — the SAME map the verifier uses, so what a person is asked to sign
 *  is what the verifier will judge. */
export const REQUIREMENT_TYPE_FOR = (capabilityId: string): string =>
  capabilityId === 'treasury.payment.execute' ? PAYMENT_RAR_TYPE : CAPABILITY_RAR_TYPE;

/** What the Ask surface gets back: an answer, the authority it would need, a question for the person, or
 *  the finished thing. One shape, so a surface never has to guess which of four states it is in. */
export type AskReply =
  | { kind: 'answer'; text: string; runRef: string }
  | { kind: 'authority_required'; runRef: string; requirement: MandateRequirementV1; delegate: Address; delegator: Address; capability: string; stepRef: string; summary: string }
  | { kind: 'prompt'; runRef: string; resumeToken: string; prompt: NonNullable<RunResult['prompt']> }
  | { kind: 'done'; runRef: string; result: unknown; receipts: RunResult['receipts'] }
  | { kind: 'refused'; runRef: string; outcome: RunResult['outcome']; error: string; receipts: RunResult['receipts'] };

/** Turn a finished run into the one reply shape. Nothing here decides anything — it reads what the loop
 *  already concluded.
 *
 *  The one thing it ADDS is prose, and only on the `answer` path: a question's result is rendered from the
 *  observations by the `AnswerComposer` (grounded in them, never beyond them). An ACTION's result is never
 *  paraphrased — what was created, at what address, in which transaction is stated from the receipt, where
 *  precision is the point. No composer, or a composer that fails, ⇒ the raw result, unchanged: the evidence
 *  is identical either way and only its rendering degrades. */
export async function askReplyFor(env: HarnessEnv, input: { intent: { goal: string }; result: RunResult; addressee: Address; composer?: AnswerComposer | null }): Promise<AskReply> {
  const r = input.result;
  if (r.outcome === 'authority-required' && r.required) {
    const requirement = mandateRequirementForStep({ required: r.required, intent: input.intent, requirementType: REQUIREMENT_TYPE_FOR(r.required.capability.id) });
    // WHOSE authority: the step's declared `authority` (the payer), else the resource it acts on (the
    // parent a team is chartered under), else the agent being asked. Never the person by default — a
    // team's authority is its workspace's — and never the token a payment moves.
    const delegator = ((r.required.capability.authority ?? r.required.capability.resource ?? input.addressee) as string).toLowerCase() as Address;
    return {
      kind: 'authority_required', runRef: r.runRef, requirement, delegator,
      delegate: (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address,
      capability: r.required.capability.id, stepRef: r.required.stepRef,
      summary: `${r.required.capability.id} on ${delegator}`,
    };
  }
  if (r.outcome === 'suspended' && r.prompt) return { kind: 'prompt', runRef: r.runRef, resumeToken: r.resumeToken ?? r.prompt.stepRef, prompt: r.prompt };
  if (r.outcome === 'completed') {
    const acted = r.receipts.some((rc) => rc.status === 'executed' && rc.risk !== 'informational');
    if (acted) return { kind: 'done', runRef: r.runRef, result: r.result ?? null, receipts: r.receipts };
    const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null);
    if (!input.composer) return { kind: 'answer', runRef: r.runRef, text: raw };
    try {
      return { kind: 'answer', runRef: r.runRef, text: await input.composer.compose({ intent: input.intent, observations: r.steps }) };
    } catch {
      return { kind: 'answer', runRef: r.runRef, text: raw };
    }
  }
  return { kind: 'refused', runRef: r.runRef, outcome: r.outcome, error: r.error ?? 'the run did not complete', receipts: r.receipts };
}

/** Run one ask under a mandate. Everything the loop decided is on the receipts; nothing here re-decides. */
export async function runUnderMandate(env: HarnessEnv, deps: HarnessDeps, input: HarnessRunInput): Promise<{ result: RunResult; plannerKind: string }> {
  const chainId = Number(env.CHAIN_ID);
  const dm = env.DELEGATION_MANAGER as Address;
  const enforcers = harnessEnforcers(env);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const wire = input.presented ? wireToDelegation(input.presented) : null;
  const presented: MandatePresentation | null = wire ? { ref: hashDelegation(wire, chainId, dm), wire } : null;
  const validator = env.UNIVERSAL_SIGNATURE_VALIDATOR as Address | undefined;

  const verifier = delegationMandateVerifier({
    actor: (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address,
    enforcers,
    checks: {
      delegationDigest: (d) => hashDelegation(d, chainId, dm),
      isRevoked: async (d) => (await deps.readContract({ address: dm, abi: IS_REVOKED_ABI, functionName: 'isRevoked', args: [hashDelegation(d, chainId, dm)] })) as boolean,
      verifySignature: async ({ signer, digest, signature }) => {
        if (!validator) return false;
        return (await deps.readContract({ address: validator, abi: universalSignatureValidatorAbi, functionName: 'isValidSig', args: [signer, digest, signature] })) === true;
      },
    },
    now,
  });
  const policy = riskLadderPolicy({ discharge: { 'second-party-approval': { role: 'steward' } } });
  const receiptSink: ReceiptSink = {
    async record(r: StepReceipt) {
      await deps.audit.write({
        id: crypto.randomUUID(), timestamp: new Date().toISOString(),
        action: `harness.step.${r.status}`, outcome: r.status === 'executed' || r.status === 'compensated' ? 'success' : r.status === 'denied' || r.status === 'failed' ? 'failure' : 'success',
        actor: { type: 'agent', id: (env.HARNESS_AGENT_SA ?? '').toLowerCase() },
        subject: { type: 'harness-step', id: `${r.runRef}:${r.stepRef}` },
        metadata: { toolId: r.toolId, risk: r.risk, capability: r.capability ?? null, mandateRef: r.authority?.presentedRef ?? null, decision: r.authority?.decision.decision ?? null, approvalRecords: r.approvalRecords ?? null, idempotencyKey: r.idempotencyKey ?? null, pendingInput: r.pendingInput ?? null, error: r.error ?? null },
      } as never);
    },
  };
  const { planner, kind } = selectPlanner(env as never);
  // What the harness may compose: the PUBLIC agent directory (read-only, through discovery — ADR-0040)
  // and the action tools, each declaring the capability and risk that decide whether it needs authority.
  // The private-vault tools are NOT here: they ride their own delegation on the orchestrate skill, and an
  // Ask is not a way around it. Nothing on this list writes to the knowledge base — the indexer is its
  // only writer, and a fact the chain does not have is a fact discovery must not be told.
  // ACTIONS FIRST. The planner picks one tool; when an ask is "do this", a directory read listed ahead of
  // the capability that does it is a plausible-looking answer to a question nobody asked.
  const tools = [...HARNESS_ACTION_TOOLS, ...ASK_DISCOVERY_TOOLS];
  const result = await runIntent(input.intent, {
    planner, tools,
    invoke: harnessInvoker(deps, env, presented, input.mcpInvoke, input.person),
    ports: { mandateVerifier: verifier, policyEvaluator: policy, approvalPort: suppliedApprovalsPort(deps, env, input.approvals ?? [], input.supplied), receiptSink },
    presented,
    // An ask with no mandate REPORTS what it would need; a run that presented one never falls back to this.
    ...(presented ? {} : { onMissingMandate: 'report' as const }),
    ...(input.supplied ? { supplied: input.supplied } : {}),
    ...(input.runRef ? { runRef: input.runRef } : {}),
    now,
  });
  return { result, plannerKind: kind };
}
