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
  type Caveat, type Delegation, type EnforcerAddresses, type MandateRequirementV1, methodSelector,} from '@agenticprimitives/delegation';
import { universalSignatureValidatorAbi } from '@agenticprimitives/chain-state-viem';
import type { AuditSink } from '@agenticprimitives/audit';
import { enforcersFromEnv } from './org-wire.js';
import { wireToDelegation, type DelegationWireV1 } from '@agenticprimitives/a2a';
import { selectPlanner, selectComposer } from './orchestration.js';
import { ASK_DISCOVERY_TOOLS } from './ask-discovery.js';
import { KB_QUESTION_TOOL, kbQuestionAvailable } from './kb-question.js';
import { resolveParty, ownAgentsOfType, candidateHint, VALUE_ARGS, type PartyLookups } from './party-resolution.js';
import { buildAskVocabulary, type AskCapabilityLike, type SurfaceCeremony, type SurfaceDescriptor, type SurfaceRiskTier } from '@agenticprimitives/surface-catalog';
import type { ResolvedParty } from './party-resolution.js';
import { MEMBERSHIP_LIST_TOOL, membershipListInvoker } from './membership-read.js';
import { RESOLUTION_REQUEST_TOOL } from './resolution-invitation.js';
import { actionLink, resolutionRequestInvoker } from './resolution-request.js';
import { partyRole, suffixesFor, COUNTERPARTY_ARGS, PARTY_ROLES } from '@agenticprimitives/ontology';
import { preconditionRefusal } from './capability-preconditions.js';
import { AUTHORITY_BEARING_CAPABILITIES } from './endeavor-authority-steps.js';
import { deriveStanding, standingNote, type Standing, type StandingDeps } from './standing.js';


export interface HarnessEnv {
  /** The Home origins this agent serves — the first is used for links a person can follow. */
  ALLOWED_ORIGINS?: string;
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

/**
 * "NONE OF THESE" AS A TOOL — spec 353 §3, the honest end of classification.
 *
 * The planner must pick a tool (`tool_choice: any` is what stops it answering in prose), so when nothing
 * fits it picks the nearest thing: asked to create a treasury with no treasury capability it created an
 * ORGANIZATION; asked to send a message with no messaging capability it read the directory and explained
 * that nothing had been sent. Both are a planner behaving reasonably with a menu that had no way to say no.
 *
 * This is that way. Selecting it is a real answer — "this agent cannot do that here" — and the reply lists
 * what it CAN do, drawn from the capabilities actually on offer rather than from the model's imagination.
 */
export const UNSUPPORTED_TOOL: ToolSpec = {
  id: 'ask.unsupported',
  description:
    'Choose this ONLY for an instruction that would CHANGE something and that no other tool performs. It '
    + 'is the correct answer for that, not a failure: better to say plainly that this agent cannot do a '
    + 'thing here than to do something adjacent to it. '
    + 'NEVER choose it for a question — anything asking to see, list, find, show or describe is answered '
    + 'with the directory tools, and "nothing found" is a real answer that this tool must not pre-empt. '
    + 'Args: what (what the person asked for, in their words).',
  inputSchema: {
    type: 'object',
    properties: { what: { type: 'string', description: 'What was asked, in the person\'s own words' } },
    required: ['what'],
  },
};

export const HARNESS_ACTION_TOOLS: ToolSpec[] = [
  {
    id: 'treasury.payment.execute',
    description: 'Pay an ERC-20 amount from one treasury (or organization) to another. Requires a payment mandate from the PAYER. Args: payer (the paying treasury/org SA — whose authority this needs), asset (token address), payee (recipient SA), amount (smallest units as a decimal string; USDC has 6 decimals, so 100 USDC is "100000000").',
    inputSchema: {
      type: 'object',
      properties: {
        payer: { type: 'string', description: 'The paying treasury or organization — its address, or its name (e.g. nathan.treasury)' },
        asset: { type: 'string', description: 'ERC-20 token contract address' },
        payee: { type: 'string', description: 'Recipient address, or its agent name (e.g. bob.me)' },
        amount: { type: 'string', description: 'Amount in the token\'s SMALLEST units (2 USDC = "2000000"). Use `usdc` instead when the ask says a decimal figure.' },
        usdc: { type: 'string', description: 'Amount in whole USDC as the person said it, e.g. "2" or "12.11". Use this when the ask names a plain figure — do not convert it yourself.' },
      },
      // Either unit, never a guess — the same vocabulary `treasury.fund` uses. A capability that
      // understood only smallest-units left "send 2 usdc" with no amount at all, which made the
      // insufficient-funds check silently pass and walked the person into a ceremony that could not work.
      //
      // `payer` is REQUIRED: a payment must say who pays. Left optional it defaulted to whoever was being
      // asked, so "from nathan.treasury" was checked — and refused — against Nathan's own empty account.
      // Whose money moves is not a detail to infer.
      // AMOUNT IS REQUIRED, and saying so here is what makes it a QUESTION rather than a crash: the
      // loop asks the person for a declared argument it lacks (§3.5), while the mandate handler — which
      // only sees the step at signing time — can do nothing but throw "args.amount is required to bound
      // the authority it needs", which is true, unactionable, and arrives after the person has typed.
      required: ['payer', 'payee', 'amount'],
    },
    // The step ACTS ON the token and needs the PAYER's authority. Conflating them asks a person to grant
    // authority as an ERC-20 contract, which nothing can sign.
    capability: { id: 'treasury.payment.execute', action: 'execute', resourceArg: 'asset', authorityArg: 'payer' },
    risk: 'high',
  },
  INVITE_TOOL,
  RESOLUTION_REQUEST_TOOL,
  {
    id: 'messaging.direct.send',
    description:
      'Send a DIRECT MESSAGE to another agent — a person, an organization, anyone with an inbox. Use this '
      + 'whenever the ask is to message, write to, tell or DM somebody. Args: recipient (their ADDRESS or '
      + 'their NAME, e.g. "alice" or "alice.me" — either works, and no lookup is needed first), message '
      + '(the text to send; omit it if the ask did not say what to write and the person will be asked).',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Who to message — an address or an agent name' },
        message: { type: 'string', description: 'The message text. Omit when the ask did not say it.' },
      },
      required: ['recipient'],
    },
    // Sending as you is acting as you: bounded by a mandate like anything else, and bound to THIS message
    // by the intent digest. Low risk — a message is never authority (ADR-0041) and can be followed by
    // another one — so the ladder asks for no second party.
    capability: { id: 'messaging.direct.send', action: 'send', resourceArg: 'recipient', authorityArg: 'sender' },
    risk: 'low',
  },
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
  /** Send a direct message through the sender's own interactions plane. */
  sendDirectMessage?: (input: { sender: Address; recipient: Address; bodyText: string; session: string }) => Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  /** Public directory search — for QUESTIONS about who exists (`find_agents`), never to fill a party in an
   *  action: a directory hit proves an agent exists, not that this person knows them (spec 352 §7). */
  findAgents?: (terms: string) => Promise<Array<{ name?: string | null; smartAgent?: string; displayName?: string | null }>>;
  /** Read one record from a subject's own vault — the asker's private tier (spec 353 §3). */
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  /** Append one entry to a subject's own record — how a request reaches the person who must decide it. */
  appendSubjectRecord?: (subject: string, recordType: string, entry: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** Held resolution grants this asker can actually use — checked, not merely held (spec 338 §4). */
  verifyGrant?: (held: unknown, type: string, asker: string, session?: string) => Promise<Array<{ targetAgent?: string; owner: string; ownerName?: string; label?: string }>>;
  /** Close the note in the ASKER'S OWN vault that was waiting on this — spec 338 §7, the far end of a
   *  request they sent. Settling is a record of what happened, never a permission: the grant it refers to
   *  stays exactly as valid as its issuer left it. */
  settleResolutionRequest?: (person: string, input: { owner: string; wants: string; txHash?: string }) => Promise<void>;
  /** The agents chartered under an owner, from the on-chain `ap:charteredUnder` edges (spec 355 W2).
   *  Public: the half of "what does this agent hold" that answers for someone else's agents. */
  charteredAgents?: (owner: string, type: string) => Promise<Array<{ agent: string; name?: string }>>;
  /** The same read with its failure reason — see `membership-read.ts` for why the difference matters. */
  readSubjectRecordStatus?: (subject: string, recordType: string) => Promise<{ ok: boolean; needsEnable?: boolean; data: unknown; error?: string }>;
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
export function suppliedApprovalsPort(
  deps: HarnessDeps, env: HarnessEnv, approvals: SuppliedApprovalV1[], supplied?: SuppliedInputV1[],
  /** Who is present. An obligation that names no particular approver still has to name SOMEBODY in the
   *  question, or the surface signs as nobody: the prompt went out with an empty `signer`, the answer came
   *  back attributed to '', and the ERC-1271 check refused an approval the person had just given. */
  person?: Address,
): ApprovalPort {
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
            digest: want, signer: allowed[0] ?? person ?? '',
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
  if (/^0[xX][0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase() as Address;
  if (!raw) throw new Error(`${what} is required`);
  // By the time an invoker reads an argument the normaliser has already resolved it (and asked, if it had
  // to). This is the last-resort exact-name read for a caller that bypassed it — never a search.
  if (!deps.resolveName || !raw.includes('.')) throw new Error(`${what} did not resolve to an agent ("${raw}")`);
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

/**
 * `messaging.direct.send` — the Home's message box, said out loud.
 *
 * The message goes through the SENDER's own interactions plane (`messaging.send`), which is where a direct
 * message already lives: one conversation per counterparty, bodies in each side's vault (ADR-0055). This
 * capability adds no storage and no second path — it resolves who was meant, asks for the words if the ask
 * did not carry them, and hands both to the plane that already does this.
 */
export function messageInvoker(deps: HarnessDeps, presented: MandatePresentation, person: Address | undefined, session: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!person || !session) throw new Error('a direct message is sent as you, and there is no signed-in person on this run');
    if (!deps.sendDirectMessage) throw new Error('messaging is not wired on this agent');
    const recipient = String(args.recipient ?? '').toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(recipient)) throw new Error(`the recipient did not resolve to an agent (${String(args.recipient ?? '')})`);
    // A planner that cannot find who was named will sometimes fill the field with whoever it DOES know —
    // and the person it knows is the asker. "Send a message to zzz-nobody-here" came back addressed to
    // Nathan. Harmless for a message and not harmless as a habit: an invented party is the failure the
    // whole resolution tier exists to prevent, so it is a question rather than a plan.
    if (recipient === person.toLowerCase()) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId,
        prompt: 'That would send the message to you. Who did you mean?',
        fields: [{ name: 'recipient', label: 'The person to message', type: 'text', required: true, hint: 'an agent name (alice.me) or address' }],
      });
    }
    const supplied = dataFor(ctx.supplied, stepRef);
    const text = String(supplied.message ?? args.message ?? '').trim();
    if (!text) {
      throw new InputRequired({
        kind: 'data', stepRef, toolId, prompt: 'What should the message say?',
        fields: [{ name: 'message', label: 'Message', type: 'text', required: true, hint: 'they will see it in their inbox, from you' }],
      });
    }
    const out = await deps.sendDirectMessage({ sender: person, recipient, bodyText: text, session });
    if (!out.ok) throw new Error(out.error);
    return { sent: true, recipient, from: person, message: text, ...(out.messageId ? { messageId: out.messageId } : {}) };
  };
}

/** The invoker: informational tools go to the existing MCP path; the payment tool redeems on chain; the
 *  team tool builds a genesis the connected user signs. */
export function harnessInvoker(deps: HarnessDeps, env: HarnessEnv, presented: MandatePresentation | null, mcpInvoke: ToolInvoker, person?: Address, session?: string, surface?: AskScopeV1, addressee?: Address): ToolInvoker {
  return async (toolId, args, ctx) => {
    // Unreachable for a capability tool (the loop refuses or reports before invoking one without a
    // mandate); explicit so a future caller cannot make it reachable quietly.
    if (!presented && (CHILD_AGENT_TLD[toolId] || toolId === 'treasury.payment.execute' || toolId === 'treasury.fund' || toolId === 'messaging.direct.send' || toolId === ORG_INVITE_CAPABILITY)) throw new Error(`${toolId} requires a mandate and none was presented`);
    if (toolId === UNSUPPORTED_TOOL.id) {
      const offered = scopedActionTools(surface).map((t) => t.capability?.id ?? t.id);
      return { unsupported: true, what: String(args.what ?? ''), available: offered };
    }
    if (toolId === MEMBERSHIP_LIST_TOOL.id) {
      return membershipListInvoker(
        {
          ...(deps.readSubjectRecord ? { readSubjectRecord: deps.readSubjectRecord } : {}),
          ...(deps.readSubjectRecordStatus ? { readSubjectRecordStatus: deps.readSubjectRecordStatus } : {}),
          ...(deps.resolveName ? { resolveName: deps.resolveName } : {}),
        },
        (addressee ?? person ?? ('0x' as Address)), person,
      )(toolId, args, ctx);
    }
    if (toolId === RESOLUTION_REQUEST_TOOL.id) {
      return resolutionRequestInvoker(
        {
          ...(deps.sendDirectMessage ? { sendDirectMessage: deps.sendDirectMessage } : {}),
          ...(deps.appendSubjectRecord ? { appendSubjectRecord: deps.appendSubjectRecord } : {}),
          ...(deps.resolveName ? { resolveName: deps.resolveName } : {}),
          ...(env.ALLOWED_ORIGINS ? { homeOrigin: env.ALLOWED_ORIGINS } : {}),
        },
        person, session,
      )(toolId, args, ctx);
    }
    if (toolId === 'messaging.direct.send') return messageInvoker(deps, presented!, person, session)(toolId, args, ctx);
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
    const payer = args.payer ? await partyAddress(args.payer, deps, 'the payer') : '';
    if (payer && payer !== (presented!.wire as Delegation).delegator.toLowerCase()) {
      throw new Error(`the payment is made by the mandate's delegator (${(presented!.wire as Delegation).delegator}); the plan named ${payer}`);
    }
    const payee = await partyAddress(args.payee, deps, 'the payee');
    const amount = fundingAmount(args);
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
    // Again, at the moment of acting: the balance may have moved since the preview, and a revert with no
    // reason is a worse answer than a sentence with the numbers in it.
    const late = await preconditionRefusal({ capability: 'treasury.payment.execute', args: { ...args, payer: wire.delegator }, env, deps });
    if (late) throw new Error(late);
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
  /** Their Home session — the interactions plane authenticates a direct message with it. */
  session?: string;
  /**
   * WHAT THE SURFACE SUPPORTS, and where the person is standing (spec 352 §2).
   *
   * The Ask is asked from inside an app, and the app knows things this agent does not: which product
   * capabilities it can actually complete a ceremony for, and what realm the person has selected. Handing
   * a planner every capability this substrate CAN do — including ones whose surface has no way to finish
   * them — invites a plan the person cannot follow through.
   *
   * SCOPING IS DISCLOSURE, NEVER AUTHORITY. A surface may only NARROW: it cannot add a capability, and
   * naming one does not permit it. The mandate is still the gate, verified per step against the chain
   * (spec 338's rule, one layer up: showing a capability does not permit it, and hiding one does not
   * protect it).
   */
  surface?: AskScopeV1;
  /** The agent being asked. Informational tools that read an organization's own records default to it —
   *  "who are the members" asked OF an organization means that one. */
  addressee?: Address;
  runRef?: string;
  /** The MCP-backed invoker for informational tools (the existing orchestrate path). */
  mcpInvoke: ToolInvoker;
}

/**
 * What the planner is told, on top of "choose a tool".
 *
 * The rule it exists to state is the one the tool shapes cannot: an ask is either a QUESTION or an
 * INSTRUCTION, and a lookup is applicable to both. Given "send 5 USDC from nathan.treasury to
 * alice2.treasury" alongside a directory read, a planner will resolve both names and stop — every step
 * defensible, the money unmoved, and a fluent paragraph explaining that no transfer was made. That is not
 * a hallucination; it is a planner doing the most obviously-safe thing with tools that did not say which
 * of them ACTS.
 *
 * So: capabilities take the words people use, and looking something up is never the answer to an
 * instruction.
 */
const ASK_PLANNER_SYSTEM =
  'You are the planning component of an agent. Choose the tool that satisfies the goal and provide its '
  + 'arguments. You may ONLY use the provided tools. Do not answer in prose — select a tool.\n\n'
  + 'An ask is either a QUESTION about what exists, or an INSTRUCTION to do something.\n'
  + '• An INSTRUCTION ("send", "pay", "fund", "create", "charter", "invite") is satisfied ONLY by the '
  + 'capability that performs it. Never answer one with a directory lookup: the capabilities take agent '
  + 'NAMES ("nathan.treasury", "bob.me") wherever they need an address and resolve them themselves, so '
  + 'there is never a reason to look an address up first. If no capability performs what was asked, choose '
  + '`ask.unsupported` — saying so is the correct answer, and a directory lookup is NOT a way of saying it. '
  + 'A capability missing from your tools does not exist here, however obviously related another one looks.\n'
  + '• A QUESTION is what the directory tools are for — and the IMPERATIVE MOOD DOES NOT MAKE ONE AN '
  + 'INSTRUCTION. "Show me the members", "list the teams", "give me her address" and "who is…" are all the '
  + 'same request: to SEE something. Answer them with the directory tools. If those return nothing, that '
  + 'is the answer — say so. NEVER choose `ask.unsupported` for a request to see, list, find, show or '
  + 'describe: `ask.unsupported` is only for an instruction that would CHANGE something this agent cannot '
  + 'change.\n\n'
  + 'MEMBERSHIP IS NOT IN THE DIRECTORY. Who belongs to an organization, team, circle or church is private '
  + 'and the public directory has never held it, so searching there returns nothing and that nothing means '
  + 'only that you looked in the wrong place. Use `organization.membership.list` for every ask about '
  + 'members, membership, rosters, "who is in" or "who belongs to".\n\n'
  + 'Missing details are not a reason to fall back to a lookup: the capability will ask the person for '
  + 'what it needs. Choosing the tool that ACTS is what lets it.\n\n'
  + 'NEVER INVENT A PLACEHOLDER. If the ask does not say an amount, a name or a recipient, OMIT that '
  + 'argument entirely — it will be asked for. Writing "<UNKNOWN>", "TBD" or a guessed number puts that '
  + 'value inside the authority the person is asked to sign.\n\n'
  + 'NEVER use an address from the context as a recipient, payee or invitee. The context tells you who is '
  + 'ASKING and which agent they are addressing — not who they are talking about. Pass the words the '
  + 'person used ("alice", "alice.me") and let the capability resolve them; if the ask names nobody, pass '
  + 'nothing and it will ask.';

/** What a presented mandate is FOR, in the words the planner knows the capability by. Read from the wire's
 *  own caveats — the mandate says what it covers, and nothing here has to be told. */
export function mandateCapabilityWords(presented: { caveats?: Array<{ enforcer?: string; terms?: string }> } | null): string | null {
  // The id is not IN the caveat: `capabilityHandler` reduces it to a 4-byte METHOD SELECTOR
  // (`methodSelector(id)`), so searching the terms for the id's own bytes matched nothing, ever — the
  // guidance this feeds was silently never added and the drift it was written to stop carried on.
  // Compare selectors, which is what is actually there.
  const terms = (presented?.caveats ?? []).map((c) => String(c.terms ?? '').toLowerCase()).join(' ');
  if (!terms) return null;
  for (const id of Object.keys(CAPABILITY_WORDS)) {
    const selector = methodSelector(id).slice(2).toLowerCase();
    if (selector && terms.includes(selector)) return CAPABILITY_WORDS[id]!;
  }
  return null;
}

/** Plain words for the capabilities an agent offers, for a refusal that says what it CAN do. An id with no
 *  word falls back to the id — an unfamiliar capability must still be readable, never silently dropped. */
const CAPABILITY_WORDS: Record<string, string> = {
  'organization.team.create': 'create teams',
  'organization.create': 'create organizations',
  'treasury.create': 'create treasuries',
  'organization.membership.invite': 'invite members',
  'treasury.payment.execute': 'make payments',
  'treasury.fund': 'fund a treasury with demo USDC',
  'messaging.direct.send': 'send direct messages',
  'resolution.invitation.request': 'ask someone how to reach an agent of theirs',
};

/** Which RAR type bounds a capability — the SAME map the verifier uses, so what a person is asked to sign
 *  is what the verifier will judge. */
export const REQUIREMENT_TYPE_FOR = (capabilityId: string): string =>
  capabilityId === 'treasury.payment.execute' ? PAYMENT_RAR_TYPE : CAPABILITY_RAR_TYPE;

/** One step's readable trace: which tool ran, how it read the question, and the query it actually sent.
 *  This is not the receipt (that is authority evidence and lives on `receipts`) — it is the answer showing
 *  its work, which is the difference between "there are none" and "I looked here and found none". */
export interface AskEvidence {
  toolId: string;
  interpretation?: string;
  query?: string;
  count?: number;
  /** What a keyword search actually looked for. A name match that found nothing and a directory that holds
   *  none of a kind are different facts, and this is the one that says which happened. */
  searched?: string;
  /** Why nothing came back, when the tool said. An answer built on a refusal must not read like an answer
   *  built on an empty result. */
  reason?: string;
}

/** Pull the trace out of what the steps observed. Only fields a tool deliberately returned for display —
 *  never the whole result, which would put arbitrary read data on a surface that did not ask for it. */
export function askEvidence(steps: RunResult['steps']): AskEvidence[] {
  const out: AskEvidence[] = [];
  for (const o of steps) {
    const r = o.result as { query?: unknown; interpretation?: unknown; count?: unknown; reason?: unknown; searchedNamesFor?: unknown; note?: unknown } | null;
    if (!r || typeof r !== 'object') continue;
    const has = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
    if (!has(r.query) && !has(r.interpretation) && !has(r.reason) && !has(r.searchedNamesFor)) continue;
    out.push({
      toolId: o.step.toolId,
      ...(has(r.interpretation) ? { interpretation: r.interpretation as string } : {}),
      ...(has(r.query) ? { query: r.query as string } : {}),
      ...(typeof r.count === 'number' ? { count: r.count } : {}),
      ...(has(r.searchedNamesFor) ? { searched: r.searchedNamesFor as string } : {}),
      // A tool's own explanation of an empty result beats anything reconstructed from the shape of it.
      ...(has(r.reason) ? { reason: r.reason as string } : has(r.note) ? { reason: r.note as string } : {}),
    });
  }
  return out;
}

/** What the Ask surface gets back: an answer, the authority it would need, a question for the person, or
 *  the finished thing. One shape, so a surface never has to guess which of four states it is in. */
export type AskReply =
  | { kind: 'answer'; text: string; runRef: string;
      /** WHAT IT READ TO SAY THAT. A generated query is the one kind of evidence a person cannot
       *  reconstruct from the answer, and an answer whose query nobody can inspect is a claim (spec 357
       *  §4). Present when a step produced one; display only, and it decides nothing. */
      evidence?: AskEvidence[] }
  | { kind: 'authority_required'; runRef: string; requirement: MandateRequirementV1; delegate: Address; delegator: Address; capability: string; stepRef: string; summary: string;
      /** What the ASKER is to the delegator, derived (spec 353 S5). Absent when nothing could read it —
       *  which is not "no standing", so a surface must not render absence as a refusal. */
      standing?: Standing; note?: string;
      /** WHO the words became. A person authorizing "send nathan a message" is authorizing it against an
       *  ADDRESS, and this is the only place they can see which one before they sign. Display only. */
      parties?: ResolvedParty[];
      /** Why standing could not be read, when it could not. Never a refusal — the ask proceeds. */
      standingUnavailable?: string }
  | { kind: 'prompt'; runRef: string; resumeToken: string; prompt: NonNullable<RunResult['prompt']> }
  | { kind: 'done'; runRef: string; result: unknown; receipts: RunResult['receipts'] }
  | { kind: 'refused'; runRef: string; outcome: RunResult['outcome']; error: string; receipts: RunResult['receipts'] };

/** Which arg a capability's RESOURCE is read from — the same declaration the tool makes, restated where
 *  the requirement is built so the two cannot disagree. */
const RESOURCE_ARG_FOR: Record<string, string> = {
  'treasury.payment.execute': 'asset',
  'treasury.fund': 'asset',
  'organization.membership.invite': 'org',
  'messaging.direct.send': 'recipient',
};

/** Arg names that hold an AGENT — a name here is the words a person used, and every one of them has to be
 *  an address by the time a caveat encodes it. */
/**
 * The arguments that name an AGENT and must become an address before anything is signed — every argument
 * any capability declares as a party, plus the two the estate carries that no capability names yet.
 *
 * Derived from the ontology binding rather than listed here, because listing them here is how the newest
 * capability got missed: `resolution.invitation.request` took an `owner`, nothing resolved it, and the
 * mandate refused to mint with "not an address or CAIP-10 account: alice.me" — after the person had
 * already been asked to grant. A capability that declares its parties now gets them resolved by saying so.
 */
const PARTY_ARGS: readonly string[] = [
  ...new Set([...PARTY_ROLES.map((r) => r.arg), 'workspace', 'funder']),
];

/**
 * Parties that are never the asker.
 *
 * A planner given the asker's address in the intent context will reach for it when it cannot find who was
 * named — "send a direct message to zzz-nobody-here" came back addressed to Nathan, and so did "send a
 * message to alice", because an address it could see beat a name it had to resolve. Paying, inviting or
 * messaging YOURSELF is not a plausible reading of any of those sentences, so it is a question.
 *
 * The counterpart args are deliberately absent: `payer`, `funder`, `parent`, `org` and `treasury` are very
 * often the asker, and asking there would be noise.
 */
export const NEVER_THE_ASKER: ReadonlySet<string> = COUNTERPARTY_ARGS;

/** What to call each of them when asking a person which one they meant. */
const PARTY_WORD: Record<string, string> = {
  payer: 'paying from', payee: 'being paid', treasury: 'the treasury', invitee: 'being invited',
  parent: 'the parent', org: 'the organization', workspace: 'the workspace', funder: 'funding it',
  recipient: 'the person to message',
};

/**
 * WHAT KIND OF AGENT EACH PARTY IS — now read from the ONTOLOGY (spec 355).
 *
 * "Send money to nathan" means nathan.treasury and "send nathan a message" means nathan.me. Same word,
 * two agents, and the difference is in the CAPABILITY. That was a table here; it is a projection of
 * `@agenticprimitives/ontology` `PARTY_ROLES` now, where each party says which ontology CLASSES it may be
 * (`ap:Treasury`, `ap:PersonAgent`) and which RELATIONSHIP to follow when the agent named is not one of
 * them (`ap:charters` — from alice to the treasury chartered under her).
 *
 * The table did not merely duplicate the ontology, it disagreed with it: it looked for a treasury whose
 * NAME matched its owner's, which the ontology never claimed and the estate does not do, so paying
 * "alice" dead-ended because alice2.treasury does not look like "alice". `check:ontology-bindings` now
 * fails the build if a binding names a term the T-box does not declare.
 */
export function partyTypesFor(capabilityId: string, arg: string): readonly string[] | undefined {
  const suffixes = suffixesFor(partyRole(capabilityId, arg));
  return suffixes.length ? suffixes : undefined;
}

/**
 * The step's args as the ENFORCERS will need them.
 *
 * A requirement is built from what the planner wrote, and the planner writes what the person said:
 * `payee: "alice2.treasury"`, `asset: "usdc"`. Both are correct English and neither can be encoded — the
 * caveat wants twenty bytes. Resolving inside the invoker is too late: the person is asked to grant an
 * authority whose limits name a string, and minting it throws. So the words become addresses HERE, once,
 * before anything is shown or signed.
 */
async function resolveStepArgs(
  args: Record<string, unknown>,
  env: HarnessEnv,
  lookups: PartyLookups,
  where?: { stepRef: string; toolId: string; capabilityId?: string; authorityArg?: string; subject?: string; required?: string[] },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...args };
  // ── WHOSE AGENT ACTS ─────────────────────────────────────────────────────────────────────────────
  // The acting party is the one whose authority the step spends, and it is the argument most likely to be
  // silently wrong: it is rarely spoken aloud ("send alice 20 USDC" names neither the sender nor the
  // payer), so it gets defaulted, and a default nobody checks becomes an authority request naming the
  // wrong agent.
  //
  // Two failures this closes, both from one omission — nobody had ever set it:
  //   · messaging declares `authorityArg: 'sender'` and no `sender` argument existed, so the delegator
  //     fell through to the RESOURCE and Nathan was asked to authorize a message AS ALICE, its recipient.
  //   · a payment took the realm the person was standing in — their person SA — as the payer, and died on
  //     a balance check against an account that holds no money and never could.
  if (where?.authorityArg && where.subject) {
    const arg = where.authorityArg;
    const current = String(out[arg] ?? '').trim();
    // Unspoken ⇒ the person asking. Acting as yourself is the only reading of "send alice a message".
    if (!current) out[arg] = where.subject.toLowerCase();
    const types = partyTypesFor(where.capabilityId ?? where.toolId, arg);
    const isAsker = String(out[arg] ?? '').toLowerCase() === where.subject.toLowerCase();
    // A person is not a treasury. When the capability acts on a kind the asker's own SA is not, find the
    // one of THEIR agents that is — the typed suffix already says which. Never a widening: their tree only.
    if (types?.length && isAsker && !types.includes('me')) {
      let found = false;
      for (const type of types) {
        const mine = await ownAgentsOfType(where.subject, type, lookups);
        if (mine.length === 1) {
          const c = mine[0]!;
          lookups.onResolved?.({ arg, raw: PARTY_WORD[arg] ?? arg, agent: c.agent, label: c.label, hint: candidateHint(c) });
          out[arg] = c.agent;
          found = true;
          break;
        }
        if (mine.length > 1) {
          // Two of yours could pay — a person may hold several treasuries, and creating one in a sentence
          // makes that ordinary. Which one is yours to say, not ours to rank.
          throw new InputRequired({
            kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
            prompt: `Which of your ${type === 'treasury' ? 'treasuries' : `${type}s`} should be ${PARTY_WORD[arg] ?? arg}?`,
            fields: [{
              name: arg, label: PARTY_WORD[arg] ?? arg, type: 'choice', required: true,
              choices: mine.map((c) => ({ value: c.agent, label: c.label, hint: candidateHint(c) })),
              // One of theirs may not be in their tree yet; a full name is always a valid answer.
              allowOther: true,
            }],
          });
        }
      }
      // NONE OF THEIRS IS OF THE RIGHT KIND — and the person SA it was defaulted to is NOT a fallback.
      // The capability says a payer is a treasury or an organization precisely because a person agent is
      // neither, and leaving it in place is how a payment came out of someone's PERSON agent while their
      // seven treasuries sat untouched. It succeeded, which was the worst part: the money left an account
      // nobody meant to spend from and the run said "done".
      if (!found) {
        throw new InputRequired({
          kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
          prompt: `You have no ${types[0]} to be ${PARTY_WORD[arg] ?? arg}. Which agent should be?`,
          fields: [{
            name: arg, label: PARTY_WORD[arg] ?? arg, type: 'text', required: true,
            hint: `give a name (yours2.${types[0]}) or an address — a ${types[0]} is what holds what would be spent`,
          }],
        });
      }
    }
  }
  for (const key of PARTY_ARGS) {
    const raw = String(out[key] ?? '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      // Nothing to resolve — and still worth reporting. An address here is usually the answer a person
      // just PICKED from a list of four Nathans; showing them a bare 0x… on the next card asks them to
      // re-verify a choice they made a moment ago against a string that tells them nothing.
      lookups.onResolved?.({ arg: key, raw, agent: raw.toLowerCase() });
      continue;
    }
    // A party the TOOL requires and the sentence did not name is a QUESTION. Skipping it because the field
    // was empty let "send a direct message to zzz-nobody-here" sail past resolution into an authority
    // request for a recipient that could not exist — failing at the last possible moment, after the person
    // had granted. An OPTIONAL party (a funder that defaults to the asker) still skips.
    if (!raw && !(where && (where.required ?? []).includes(key))) continue;
    if (where) {
      // Inside a run: resolve properly, and ASK when the words name several agents or none.
      // A party that arrived as the asker's own address was not resolved from the sentence — it was
      // borrowed from the context. Ask before that becomes an authority request naming the wrong person.
      if (NEVER_THE_ASKER.has(key) && where.subject && raw.toLowerCase() === where.subject.toLowerCase()) {
        throw new InputRequired({
          kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
          prompt: `That would be you. Who is ${PARTY_WORD[key] ?? key}?`,
          fields: [{ name: key, label: PARTY_WORD[key] ?? key, type: 'text', required: true, hint: 'an agent name (alice.me) or address' }],
        });
      }
      out[key] = await resolveParty(raw, lookups, {
        stepRef: where.stepRef, toolId: where.toolId, argName: key, what: PARTY_WORD[key] ?? key,
        // WHOSE tier: the person asking. Without a subject the private providers are skipped and the
        // answer is an honest "unknown" — never a widening to a public search.
        ...(where.subject ? { subject: where.subject } : {}),
        // WHAT KIND of agent this argument is, so "nathan" means his treasury when money moves and him
        // when a message is sent. Undeclared ⇒ no narrowing: a capability that has not said what it acts
        // on gets every candidate and, if there are several, a question.
        ...(() => { const t = partyTypesFor(where.capabilityId ?? where.toolId, key); return t ? { types: t } : {}; })(),
        // What the ask was FOR, so a request raised from this dead end can carry it and be finished in
        // one press later. EITHER UNIT: the planner writes `usdc: "3"` or `amount: "3000000"` and both
        // are honest readings of "3 usdc" — reading only the first meant the amount was dropped exactly
        // when the sentence had named one.
        ...(() => {
          const whole = String(out.usdc ?? '').trim();
          if (/^\d+(\.\d+)?$/.test(whole)) return { pendingAmount: whole };
          const smallest = String(out.amount ?? '').trim();
          if (!/^\d+$/.test(smallest)) return {};
          const n = Number(smallest) / 1e6;
          return Number.isFinite(n) && n > 0 ? { pendingAmount: String(n) } : {};
        })(),
      });
      continue;
    }
    // Outside a run (building a requirement to display): resolve what is certain, leave the rest as
    // written — there is nobody to ask here, and a silent guess is the thing to avoid.
    const resolved = raw.includes('.') && lookups.resolveName ? await lookups.resolveName(raw.toLowerCase()).catch(() => null) : null;
    if (resolved) out[key] = resolved.toLowerCase();
  }
  // ANYTHING THE TOOL DECLARED AND THE SENTENCE DID NOT GIVE IS A QUESTION (§3.5).
  //
  // Party arguments are asked for above. Everything else was nobody's job, so "send money to alice" —
  // which names no figure — reached the mandate handler and died there on "args.amount is required to
  // bound the authority it needs": true, unactionable, and after the person had already typed. The loop
  // can just ask. `amount` and `usdc` are the same requirement in two units, so either satisfies it.
  const ALTERNATIVES: Record<string, readonly string[]> = { amount: ['amount', 'usdc'] };
  const WORD_FOR_ARG: Record<string, { label: string; hint: string }> = {
    amount: { label: 'How much', hint: 'in whole USDC, e.g. 10 or 12.50' },
    message: { label: 'Message', hint: 'what to say' },
    label: { label: 'Name', hint: 'lowercase letters, digits and hyphens' },
  };
  // A PLACEHOLDER IS NOT AN ANSWER. Asked to "send money to alice" with no figure, the planner filled the
  // amount with the literal string "<UNKNOWN>" — so the argument was present, this check passed, and the
  // person was shown a mandate whose ceiling was a placeholder. An argument counts as given only if it is
  // the KIND of value it is supposed to be; for a quantity that means a number.
  const NUMERIC = new Set(['amount', 'usdc']);
  const given = (k: string): boolean => {
    const v = String(out[k] ?? '').trim();
    if (!v) return false;
    if (/^<.*>$|^(unknown|tbd|n\/a|null|undefined)$/i.test(v)) return false;
    if (NUMERIC.has(k)) return /^\d+(\.\d+)?$/.test(v);
    return true;
  };
  if (where?.required?.length) {
    const missing = where.required.filter((k) => !PARTY_ARGS.includes(k)
      && (ALTERNATIVES[k] ?? [k]).every((alt) => !given(alt)));
    // A placeholder must not survive into the step either: it would be encoded into a caveat.
    for (const k of NUMERIC) if (String(out[k] ?? '').trim() && !given(k)) delete out[k];
    if (missing.length) {
      const fields: InputFieldV1[] = missing.map((k) => ({
        name: (ALTERNATIVES[k]?.[1] ?? k),
        label: WORD_FOR_ARG[k]?.label ?? k,
        type: 'text' as const, required: true,
        ...(WORD_FOR_ARG[k]?.hint ? { hint: WORD_FOR_ARG[k]!.hint } : {}),
      }));
      throw new InputRequired({
        kind: 'data', stepRef: where.stepRef, toolId: where.toolId,
        prompt: missing.length === 1 && missing[0] === 'amount' ? 'How much should I send?' : 'I need a little more to do that.',
        fields,
      });
    }
  }

  // ONE UNIT, ONCE. The planner may say `usdc: "2"` or `amount: "2000000"` — both are honest readings of
  // "2 usdc" — but everything downstream (the caveat's ceiling, the balance check, the invoker) must see
  // exactly one. Converting here means the delegation package never learns a token symbol and no reader
  // has to guess which field to trust; leaving it to them is how `stepLimits` came to throw on an amount
  // the person had plainly stated.
  if (out.usdc !== undefined && out.amount === undefined) {
    out.amount = fundingAmount(out).toString();
    delete out.usdc;
  }

  // THE TOKEN IS A DEPLOYMENT FACT, AND THE PLANNER MUST NOT SUPPLY IT.
  //
  // Asked to send USDC, a model wrote `0x036CbD53842c5426634e7929541eC2318f3dCF7e` — Base Sepolia's USDC,
  // recalled from memory, address-shaped and confidently wrong for this chain. Accepting it would have put
  // a contract that does not exist here inside a signed mandate's allowedTargets, and the person granting
  // would have read "make payments" over a token nobody can name.
  //
  // This deployment has exactly ONE demo token, so which token is not a choice a planner gets to make.
  // A deployment with several would make it a real choice, and would need a real check — not this.
  if (env.MOCK_USDC) out.asset = String(env.MOCK_USDC).toLowerCase();
  return out;
}

/** Turn a finished run into the one reply shape. Nothing here decides anything — it reads what the loop
 *  already concluded.
 *
 *  The one thing it ADDS is prose, and only on the `answer` path: a question's result is rendered from the
 *  observations by the `AnswerComposer` (grounded in them, never beyond them). An ACTION's result is never
 *  paraphrased — what was created, at what address, in which transaction is stated from the receipt, where
 *  precision is the point. No composer, or a composer that fails, ⇒ the raw result, unchanged: the evidence
 *  is identical either way and only its rendering degrades. */
/**
 * THE THING THEY WERE WAITING FOR HAPPENED — spec 338 §7.
 *
 * Someone could not be reached, so they asked; a grant came back and their Home remembered what it was
 * for. The moment the payment that grant enabled settles, that note has nothing left to wait on. Left
 * open it keeps offering a payment already made, which is the one thing a "finish this" card must never
 * invite.
 *
 * Only a party reached THROUGH its owner's disclosure closes anything: an address typed outright was
 * nobody's answer to anything. Best-effort, and deliberately so — the money has moved and been receipted;
 * a note that fails to close costs a card, not a payment, and failing the run over it would be worse.
 */
async function settleFinishedRequests(
  input: { deps?: HarnessDeps; principal?: Address; resolved?: ResolvedParties; session?: string },
  r: RunResult,
): Promise<void> {
  const settle = input.deps?.settleResolutionRequest;
  if (!settle || !input.principal) return;
  const paid = r.receipts.filter((rc) => rc.toolId === 'treasury.payment.execute' && rc.status === 'executed');
  if (!paid.length) return;
  const txHash = (r.result as { txHash?: string } | null)?.txHash;

  // The args that MOVE VALUE, from the ontology binding (spec 355) — not a hand-kept list of arg names
  // that would drift the first time a capability names its payee something else.
  const paidTo = [...(input.resolved?.values() ?? [])].filter((p) => VALUE_ARGS.has(p.arg));
  if (!paidTo.length) return;

  // WHOSE NOTE THIS CLOSES IS A QUESTION ABOUT WHERE THE MONEY WENT, not about how the payee was
  // phrased. `ownedBy` is there when the run followed someone's disclosure to get the address — but a
  // person who answered "which treasury?" by picking one, or who pasted the address outright, paid the
  // very same agent and is owed the same finished card. So when the resolution did not carry an owner,
  // ask the records that can say: a held grant whose target IS this payee names the person who gave it.
  const owners = new Set(paidTo.map((p) => p.ownedBy).filter((o): o is string => !!o));
  const unattributed = paidTo.filter((p) => !p.ownedBy).map((p) => p.agent.toLowerCase());
  if (unattributed.length && input.deps?.verifyGrant && input.deps.readSubjectRecord && input.session) {
    const held = await input.deps.readSubjectRecord(input.principal, 'resolution.grants').catch(() => null);
    const grants = await input.deps.verifyGrant(held, 'treasury', input.principal, input.session).catch(() => []);
    for (const g of grants) {
      if (g.targetAgent && unattributed.includes(g.targetAgent.toLowerCase())) owners.add(g.owner.toLowerCase());
    }
  }

  for (const owner of owners) {
    await settle(input.principal, { owner, wants: 'treasury', ...(txHash ? { txHash } : {}) }).catch(() => undefined);
  }
}

export async function askReplyFor(env: HarnessEnv, input: {
  intent: { goal: string }; result: RunResult; addressee: Address;
  /** What the surface said it can render — a prompt it never declared is refused, not stranded. */
  surface?: AskScopeV1;
  composer?: AnswerComposer | null;
  /** Read-only checks that spare a person a ceremony whose outcome is already knowable (spec 352 §2).
   *  Absent ⇒ no early refusal; the chain still decides. */
  deps?: HarnessDeps;
  /** Resolve a NAME the planner passed where an address is needed. The requirement is built from the
   *  step's args BEFORE any invoker runs, so "as nathan.treasury" has to become an address here or the
   *  person is asked to grant authority as a string nothing can sign. */
  resolveName?: (name: string) => Promise<string | null>;
  /** The person asking. Used ONLY to say, before a ceremony, what they are to the agent whose authority
   *  the plan needs — never consulted by a gate (spec 353 §4). */
  principal?: Address;
  /** Verifies a stewardship wire on chain. Absent ⇒ a held wire is not upgraded to `steward` on its word. */
  verifyStewardship?: StandingDeps['verifyStewardship'];
  /** What the run's party words resolved to, for the surface to show back before a signature. */
  resolved?: ResolvedParties;
  /** The asker's Home session — carried so a finished payment can ask the resolver gate whose disclosure
   *  it used, which is what says whose note it just closed. */
  session?: string;
}): Promise<AskReply> {
  const r = input.result;
  if (r.outcome === 'authority-required' && r.required) {
    // Already normalised by the loop (`normalizeArgs`); re-run defensively for a caller that did not.
    const args = await resolveStepArgs(r.required.args, env, { ...(input.resolveName ? { resolveName: input.resolveName } : {}) });
    // The resource was read out of an arg BEFORE the args were normalised, so it has to be re-read from
    // the resolved ones — not merely repaired when it looks wrong. It looked fine: the planner's recalled
    // token address is a perfectly well-formed address for another chain, and `locations` would have
    // pinned the mandate to it while `limits` named the real one.
    const resourceArg = RESOURCE_ARG_FOR[r.required.capability.id] ?? 'parent';
    const resource = String(args[resourceArg] ?? r.required.capability.resource ?? '');
    const required = {
      ...r.required,
      args,
      capability: { ...r.required.capability, ...(resource ? { resource } : {}) },
    };
    // BEFORE asking anyone to authorize this: is it already impossible? Walking a person through a
    // signature for a payment their account cannot cover is the same wrong as asking them to grant
    // authority they do not hold — knowable in advance, and cruel to discover afterwards.
    if (input.deps) {
      const refusal = await preconditionRefusal({ capability: required.capability.id, args, env, deps: input.deps, addressee: input.addressee });
      if (refusal) return { kind: 'refused', runRef: r.runRef, outcome: 'denied', error: refusal, receipts: r.receipts };
    }
    const requirement = mandateRequirementForStep({ required, intent: input.intent, requirementType: REQUIREMENT_TYPE_FOR(r.required.capability.id) });
    // WHOSE authority: the step's declared `authority` (the payer), else the resource it acts on (the
    // parent a team is chartered under), else the agent being asked. Never the person by default — a
    // team's authority is its workspace's — and never the token a payment moves.
    // A capability that DECLARES whose authority it spends does not get to fall through to the thing it
    // acts on. That fallthrough is how "send alice a message" became a request to authorize it AS ALICE:
    // messaging declares `authorityArg: 'sender'`, nothing set a sender, and the resource — the recipient
    // — was next in line. Acting-party resolution now always fills it; this makes the old route
    // unreachable rather than merely unused.
    const declaresAuthority = !!HARNESS_ACTION_TOOLS.find((t) => (t.capability?.id ?? t.id) === r.required!.capability.id)?.capability?.authorityArg;
    const fallback = declaresAuthority ? input.addressee : (required.capability.resource ?? input.addressee);
    const named = ((required.capability.authority ?? fallback) as string).trim();
    const delegator = (/^0x[0-9a-fA-F]{40}$/.test(named)
      ? named
      : ((input.resolveName ? await input.resolveName(named.toLowerCase()) : null) ?? input.addressee)).toLowerCase() as Address;
    // WHO CAN GRANT THIS (spec 353 S5). The chain will decide either way; the point is to decide it BEFORE
    // a person signs rather than after. A member who signs as an org they do not custody gets a `not-live`
    // verdict that is accurate, unhelpful, and arrives once the work is already done.
    let standing: Standing | undefined;
    // An UNREADABLE standing is not "no standing", and it must not read as one. Absence gets a reason, so
    // a surface (and whoever is debugging it) can tell "we looked and they are a member" apart from "we
    // never looked", which are opposite facts that look identical when the field is simply missing.
    let standingUnavailable: string | undefined;
    if (!input.principal) standingUnavailable = 'the asker was not named to this reply';
    else if (!input.deps?.readSubjectRecord) standingUnavailable = 'this agent cannot read the asker\'s links';
    else {
      const read = input.deps.readSubjectRecord;
      standing = await deriveStanding(
        { readSubjectRecord: read, ...(input.verifyStewardship ? { verifyStewardship: input.verifyStewardship } : {}) },
        { principal: input.principal, subject: delegator },
      ).catch((e: unknown) => { standingUnavailable = e instanceof Error ? e.message : String(e); return undefined; });
    }
    const note = standing ? standingNote(standing, CAPABILITY_WORDS[r.required.capability.id] ?? 'authority') : '';
    return {
      kind: 'authority_required', runRef: r.runRef, requirement, delegator,
      delegate: (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address,
      capability: r.required.capability.id, stepRef: r.required.stepRef,
      summary: `${r.required.capability.id} on ${delegator}`,
      ...(standing ? { standing } : {}), ...(note ? { note } : {}),
      ...(standingUnavailable ? { standingUnavailable } : {}),
      // Only the parties this STEP actually names — a run that resolved three things does not get to
      // show all three under a mandate that covers one.
      ...(() => {
        const named = [...(input.resolved?.values() ?? [])].filter((p) => Object.values(args).some((v) => String(v).toLowerCase() === p.agent));
        return named.length ? { parties: named } : {};
      })(),
    };
  }
  if (r.outcome === 'suspended' && r.prompt) {
    // CEREMONY NEGOTIATION (spec 353 S4). Offering only what a surface can finish catches this at plan
    // time; this catches the rest — a capability that asks for something its risk tier never implied, or a
    // surface whose declaration and behaviour have drifted. A run that suspends on a prompt nobody can
    // answer is not waiting, it is stuck, and stuck reads to a person as broken rather than as unsupported.
    const kind = r.prompt.kind;
    const declared = input.surface?.ceremonies;
    if (declared?.length && !new Set([...ASSUMED_CEREMONIES, ...declared]).has(kind)) {
      return {
        kind: 'refused', runRef: r.runRef, outcome: 'denied', receipts: r.receipts,
        error: `this needs a ${kind} and this surface cannot collect one — nothing was authorized`,
      };
    }
    // STANDING BEFORE THE QUESTION (spec 353 S5). A prompt is a demand on a person. Asking a member to
    // look up an invitee's address for an invitation only a steward can authorize spends their effort on
    // a refusal we could already see — the same wrong as collecting a signature that will not verify.
    //
    // Only on POSITIVE evidence: `member` means we read their links and they hold no stewardship there.
    // `none` does NOT refuse — a person can custody an agent that no row of theirs mentions, and custody
    // at grant time is the gate. Fail open on ambiguity, closed only on what was actually read.
    const pendingCapability = r.prompt.toolId ?? '';
    if (input.principal && input.deps?.readSubjectRecord && AUTHORITY_BEARING_CAPABILITIES.includes(pendingCapability)) {
      const st = await deriveStanding(
        { readSubjectRecord: input.deps.readSubjectRecord, ...(input.verifyStewardship ? { verifyStewardship: input.verifyStewardship } : {}) },
        { principal: input.principal, subject: input.addressee },
      ).catch(() => null);
      if (st?.relation === 'member') {
        return {
          kind: 'refused', runRef: r.runRef, outcome: 'denied', receipts: r.receipts,
          error: standingNote(st, CAPABILITY_WORDS[pendingCapability] ?? pendingCapability),
        };
      }
    }
    return { kind: 'prompt', runRef: r.runRef, resumeToken: r.resumeToken ?? r.prompt.stepRef, prompt: r.prompt };
  }
  if (r.outcome === 'completed') {
    // "None of these" is stated, never composed: a model asked to phrase a refusal will soften it into a
    // suggestion, and the useful part is the list of what this agent CAN do — which is not its to invent.
    const unsupported = r.steps.find((o) => o.ok && (o.result as { unsupported?: boolean } | null)?.unsupported);
    if (unsupported) {
      const u = unsupported.result as { what?: string; available?: string[] };
      const can = (u.available ?? []).map((id) => CAPABILITY_WORDS[id] ?? id);
      return {
        kind: 'answer', runRef: r.runRef,
        // Quoted rather than folded into the sentence: the person's words come back in their own person
        // ("book me a flight"), and "I can't book me a flight" reads like a machine that did not listen.
        text: u.what?.trim()
          ? `I can't help with “${u.what.trim()}” here.${can.length ? ` What I can do as this agent: ${can.join(', ')}.` : ''}`
          : `I can't do that here.${can.length ? ` What I can do as this agent: ${can.join(', ')}.` : ''}`,
      };
    }
    const acted = r.receipts.some((rc) => rc.status === 'executed' && rc.risk !== 'informational');
    if (acted) {
      await settleFinishedRequests(input, r).catch(() => undefined);
      return { kind: 'done', runRef: r.runRef, result: r.result ?? null, receipts: r.receipts };
    }
    const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null);
    const evidence = askEvidence(r.steps);
    const withEvidence = (text: string): AskReply => ({ kind: 'answer', runRef: r.runRef, text, ...(evidence.length ? { evidence } : {}) });
    if (!input.composer) return withEvidence(raw);
    try {
      return withEvidence(await input.composer.compose({ intent: input.intent, observations: r.steps }));
    } catch {
      return withEvidence(raw);
    }
  }
  return { kind: 'refused', runRef: r.runRef, outcome: r.outcome, error: r.error ?? 'the run did not complete', receipts: r.receipts };
}

/**
 * WHAT THE APP CAN DO, AND WHERE THE PERSON IS STANDING — spec 353's `AskScopeV1`, the scope half of an ask.
 *
 * An Ask never happens in a vacuum: it happens inside an app, with a connected user, acting in a selected
 * context. All three are already substrate facts, and the app knows them before the harness runs.
 *
 * SCOPE IS HONESTY; THE MANDATE IS AUTHORITY. This decides what the conversation OFFERS, how it phrases
 * things and how it refuses. It decides nothing about what is permitted, and it is consumed BEFORE the
 * authority stage: it is not a parameter of `verifyMandateForStep`, of the `PolicyEvaluator`, or of any
 * gate. Threading it into a verifier is the drift to refuse (353 §4).
 *
 * WHAT IS DELIBERATELY ABSENT: roles, memberships, entitlements, policy verdicts. An app-asserted role is
 * a client-supplied authorization claim — the exact pattern ADR-0041 forbids and Pydantic warns about —
 * so standing is DERIVED here from vault and chain, never accepted from the payload. An earlier cut of
 * this carried `role: 'steward' | 'member'` from the Home; it is removed rather than ignored, because a
 * field that exists gets used.
 */
export interface AskScopeV1 {
  /** Capability ids this app can carry to completion. Absent ⇒ everything this agent offers. */
  capabilities?: string[];
  /** Prompt kinds and ceremonies this surface can actually render (350 §3.5 kinds, plus
   *  'mandate-signature'). A run that would suspend on one the app cannot render should refuse at plan
   *  time rather than strand (353 S4 — not yet enforced). */
  ceremonies?: string[];
  /** The realm the person selected, as the app understands it — the delegator candidate and the private
   *  tier. NOT their standing in it. */
  realm?: { kind?: 'person' | 'org' | 'service' };
}

/**
 * WHAT EACH CAPABILITY WILL ASK A PERSON FOR — spec 353 S4.
 *
 * Risk implies a floor (a payment is high, so somebody signs), but it does not predict everything:
 * `organization.team.create` is MEDIUM and still needs a signature, because an agent's genesis is signed
 * by the credential that will custody it. A ceremony list derived from risk alone would have declared that
 * capability renderable by a surface that cannot collect a signature, and the run would have suspended on
 * a prompt nobody could answer — the Mastra failure class, arriving through the UX door instead of the
 * storage one.
 *
 * So each capability states what it may ask for. `data` and `confirmation` are assumed of every surface (a
 * conversation that cannot ask a question is not a conversation); only the ceremonies BEYOND that are
 * listed, because those are the ones an app can genuinely lack.
 */
export const CAPABILITY_CEREMONIES: Record<string, string[]> = {
  'organization.team.create': ['signature'],        // the child's genesis
  'organization.create': ['signature'],
  'treasury.create': ['signature'],
  'organization.membership.invite': ['signature'],  // the org signs the invitation grant
  'treasury.payment.execute': ['signature'],        // the mandate, and the ladder's second party
  'treasury.fund': ['signature'],                   // the mandate
  'messaging.direct.send': ['signature'],           // the mandate — sending as you is acting as you
  'resolution.invitation.request': ['signature'],   // the mandate — asking is an act of yours too
};

/** Ceremonies every surface is assumed to render: it is a conversation, so it can ask and be answered. */
const ASSUMED_CEREMONIES = ['data', 'confirmation'];

/** Can this surface complete this capability? Silence means yes — a surface that has not said what it
 *  renders is not narrowed by its silence (the same rule as `capabilities`). */
export function surfaceCanRender(capabilityId: string, ceremonies?: string[]): boolean {
  if (!ceremonies?.length) return true;
  const renders = new Set([...ASSUMED_CEREMONIES, ...ceremonies]);
  return (CAPABILITY_CEREMONIES[capabilityId] ?? []).every((c) => renders.has(c));
}

/**
 * THE ASK VOCABULARY THIS AGENT PUBLISHES — spec 353 S2, the ∩ a surface computes its scope from.
 *
 * PROJECTED from the same tool declarations the planner composes with, never a second list. The moment
 * this is hand-kept it drifts: the vocabulary advertises a capability the planner cannot pick, or the
 * planner offers one the vocabulary never named, and both lists are separately right.
 *
 * Vocabulary is DISCLOSURE. A capability appearing here permits nothing — the mandate decides authority,
 * and this list is not consulted by any gate (spec 353 §4).
 */
export function askDescriptors(): SurfaceDescriptor[] {
  return HARNESS_ACTION_TOOLS.filter((t) => t.id !== UNSUPPORTED_TOOL.id).map((t) => {
    const id = t.capability?.id ?? t.id;
    return {
      id,
      protocol: 'a2a' as const,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema as Record<string, unknown>,
      authorization: {
        mode: 'agentic-delegation' as const,
        riskTier: (t.risk ?? 'medium') as SurfaceRiskTier,
        // What this one may ASK A PERSON for, beyond its risk floor. `organization.team.create` is medium
        // and still needs a signature — see CAPABILITY_CEREMONIES.
        ...(CAPABILITY_CEREMONIES[id]?.length ? { ceremonies: CAPABILITY_CEREMONIES[id] as SurfaceCeremony[] } : {}),
      },
      // `key-required`, not `never-retry`: every authority-bearing step here derives its on-chain nonce
      // from the intent, so the SAME ask retried settles once and a second submission reverts. Retrying
      // is safe with the same key and is not safe without one.
      operations: { rateLimitProfile: 'harness', maxBodyBytes: 65536, timeoutMs: 30000, idempotency: 'key-required' as const, cache: 'no-store' as const },
    };
  });
}

/** The vocabulary as a surface consumes it: every capability, with the ceremonies it may ask for and the
 *  PLAIN WORDS for it. The words travel with the capability because a surface that keeps its own list
 *  keeps a list that goes stale: the Home's copy was missing three, so a person granting authority to send
 *  a message read "needs permission to messaging.direct.send", which is the id, not a sentence. */
/**
 * WHAT IS WAITING ON THIS PERSON — surfaced when they open the Ask, not left for them to remember.
 *
 * A request lands in someone's records and a message lands in their inbox, and both rely on them going
 * to look. The one surface they DID open is this one, so it is the right place to say "someone is waiting
 * on you" — once, briefly, and only about things that are genuinely theirs to decide.
 *
 * It reports; it never acts. Nothing here approves anything, and the words point at where the decision is
 * made rather than pretending it can be made in a sentence.
 */
export async function waitingOn(
  deps: { readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown> },
  person: string | undefined,
  homeOrigin?: string,
): Promise<string | null> {
  if (!person || !deps.readSubjectRecord) return null;
  const doc = await deps.readSubjectRecord(person, 'resolution.requests').catch(() => null);
  const rows = (doc as { requests?: Array<{ kind?: string; requester?: string; wants?: string; status?: string }> } | null)?.requests ?? [];
  const pending = rows.filter((r) => r.kind !== 'resolution.invitation.sent' && !!r.requester && (r.status ?? 'pending') === 'pending');
  if (!pending.length) return null;
  const where = actionLink(homeOrigin, '/treasuries');
  const what = pending.length === 1
    ? `Someone has asked you for a way to reach your ${pending[0]!.wants ?? 'agent'}.`
    : `${pending.length} people have asked you for a way to reach agents of yours.`;
  // WHERE, not just what. A notice that does not say where to go is one more thing to work out.
  return `${what}${where ? ` You decide at ${where}.` : ''}`;
}

export function askVocabulary(): Array<AskCapabilityLike & { label: string }> {
  return buildAskVocabulary(askDescriptors()).map((c) => ({ ...c, label: CAPABILITY_WORDS[c.id] ?? c.id }));
}

/**
 * The action tools this ask may compose: what this agent offers, narrowed by what the SURFACE says it can
 * complete and by the realm the person is standing in. Narrowing only — a surface that names a capability
 * this agent does not have gets nothing extra, and a realm never grants.
 */
export function scopedActionTools(surface?: AskScopeV1): ToolSpec[] {
  let tools = HARNESS_ACTION_TOOLS;
  const declared = surface?.capabilities?.length ? new Set(surface.capabilities) : null;
  if (declared) tools = tools.filter((t) => declared.has(t.capability?.id ?? t.id));
  // A person's own realm charters organizations; an organization charters what lives inside it. Offering
  // `organization.create` while standing in a service is offering a plan whose parent makes no sense.
  const kind = surface?.realm?.kind;
  if (kind === 'org') tools = tools.filter((t) => t.id !== 'organization.create');
  if (kind === 'service') tools = tools.filter((t) => !CHILD_AGENT_TLD[t.id] && t.id !== ORG_INVITE_CAPABILITY);
  // Do not OFFER what this surface cannot finish. A plan built from a capability whose ceremony nobody can
  // render is a plan that strands mid-run, after the person has already been asked for things.
  tools = tools.filter((t) => surfaceCanRender(t.capability?.id ?? t.id, surface?.ceremonies));
  return tools;
}


/** Run one ask under a mandate. Everything the loop decided is on the receipts; nothing here re-decides. */
/** What the run's party words became, keyed so the same party resolved twice is recorded once. Display
 *  only — nothing reads it to decide anything. */
export type ResolvedParties = Map<string, ResolvedParty>;

export async function runUnderMandate(env: HarnessEnv, deps: HarnessDeps, input: HarnessRunInput): Promise<{ result: RunResult; plannerKind: string; resolved: ResolvedParties }> {
  const resolved: ResolvedParties = new Map();
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
  // AUTHORITY ALREADY IN HAND. A turn that presents a mandate is the turn AFTER a person granted one for
  // this ask — and re-planning from scratch let it drift to a different tool, so the grant bought nothing
  // and the person was told "I can't help with that" one step after being told it needed their signature.
  // Saying what the mandate covers is guidance, never authority: the verifier still judges the step, and a
  // plan that ignores this is refused by the same gates as any other.
  const holding = input.presented ? mandateCapabilityWords(input.presented) : null;
  const systemPrompt = holding
    ? `${ASK_PLANNER_SYSTEM}

The person has ALREADY granted authority to ${holding} for this exact ask. That is the capability to use; do not choose another, and do not choose ask.unsupported.`
    : ASK_PLANNER_SYSTEM;
  const { planner, kind } = selectPlanner(env as never, { systemPrompt });
  // What the harness may compose: the PUBLIC agent directory (read-only, through discovery — ADR-0040)
  // and the action tools, each declaring the capability and risk that decide whether it needs authority.
  // The private-vault tools are NOT here: they ride their own delegation on the orchestrate skill, and an
  // Ask is not a way around it. Nothing on this list writes to the knowledge base — the indexer is its
  // only writer, and a fact the chain does not have is a fact discovery must not be told.
  // ACTIONS FIRST. The planner picks one tool; when an ask is "do this", a directory read listed ahead of
  // the capability that does it is a plausible-looking answer to a question nobody asked.
  // Membership is a QUESTION, and its answer is private — so it sits with the informational tools (no
  // mandate, nothing changes) rather than among the capabilities, and it is offered whatever the surface
  // declared: a scope narrows what may be DONE, never what may be asked.
  // `kb.question` is offered only where a model can write the query (spec 357 W3). Listing a tool the
  // agent cannot run would have the planner pick it and the step fail — and a tool that degraded to a
  // keyword search instead would answer a different question than the one it advertised (ADR-0013).
  const tools = [
    ...scopedActionTools(input.surface), ...ASK_DISCOVERY_TOOLS,
    ...(kbQuestionAvailable(env as never) ? [KB_QUESTION_TOOL] : []),
    MEMBERSHIP_LIST_TOOL, UNSUPPORTED_TOOL,
  ];
  const result = await runIntent(input.intent, {
    planner, tools,
    invoke: harnessInvoker(deps, env, presented, input.mcpInvoke, input.person, input.session, input.surface, input.addressee),
    // The person's words become this substrate's own ONCE, before the capability is extracted, before the
    // verifier judges the step and before any invoker reads an argument. Anywhere later and the run is
    // judging "alice2.treasury" against an allowlist of addresses.
    // The stepRef is a placeholder: the loop stamps the real one onto any question this raises, because
    // only the loop knows which step it was normalising for.
    normalizeArgs: ({ toolId, tool, args }) => resolveStepArgs(args, env, { ...deps, ...(input.session ? { session: input.session } : {}), onResolved: (r) => {
      // The SAME party can be reported twice — once resolved from words or from the asker's own tree, and
      // once again as the plain address it now is. Keep whichever knows its name: overwriting a labelled
      // record with a bare address is how "nathan.treasury" became "0x2c47…" on the card a person reads
      // before signing.
      const key = `${r.arg}:${r.agent}`;
      if (r.label || !resolved.has(key)) resolved.set(key, r);
    } }, {
      stepRef: 'pending', toolId, ...(tool.capability?.id ? { capabilityId: tool.capability.id } : {}),
      // WHOSE authority this step spends — declared by the tool, never inferred from the sentence.
      ...(tool.capability?.authorityArg ? { authorityArg: tool.capability.authorityArg } : {}),
      ...(input.person ? { subject: input.person } : {}),
      // The tool's OWN declaration of what it cannot work without — asked for, never inferred.
      required: (tool.inputSchema as { required?: string[] } | undefined)?.required ?? [],
    }),
    ports: { mandateVerifier: verifier, policyEvaluator: policy, approvalPort: suppliedApprovalsPort(deps, env, input.approvals ?? [], input.supplied, input.person), receiptSink },
    presented,
    // An ask with no mandate REPORTS what it would need; a run that presented one never falls back to this.
    ...(presented ? {} : { onMissingMandate: 'report' as const }),
    ...(input.supplied ? { supplied: input.supplied } : {}),
    ...(input.runRef ? { runRef: input.runRef } : {}),
    now,
  });
  return { result, plannerKind: kind, resolved };
}
