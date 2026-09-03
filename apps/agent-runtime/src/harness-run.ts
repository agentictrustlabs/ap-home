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
  type RunResult, type ToolSpec, type ToolInvoker, type ApprovalPort, type ReceiptSink, type StepReceipt, type MandatePresentation, type SuppliedInputV1, type InputFieldV1,
} from '@agenticprimitives/orchestration';
import { delegationMandateVerifier, riskLadderPolicy } from '@agenticprimitives/harness';
import {
  hashDelegation, intentDigest, encodeDigestBindingArgs, decodeTimestampTerms, type Delegation, type EnforcerAddresses,
} from '@agenticprimitives/delegation';
import { universalSignatureValidatorAbi } from '@agenticprimitives/chain-state-viem';
import type { AuditSink } from '@agenticprimitives/audit';
import { enforcersFromEnv } from './org-wire.js';
import { wireToDelegation, type DelegationWireV1 } from '@agenticprimitives/a2a';
import { selectPlanner, ORCHESTRATION_TOOLS } from './orchestration.js';


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
export const HARNESS_ACTION_TOOLS: ToolSpec[] = [
  {
    id: 'treasury.payment.execute',
    description: 'Pay an ERC-20 amount from the PAYER (the mandate\'s delegator — an org or treasury) to a payee. Requires a payment mandate. Args: asset (token address), payee (address), amount (smallest units, as a string).',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'ERC-20 token contract address' },
        payee: { type: 'string', description: 'Recipient address' },
        amount: { type: 'string', description: 'Amount in the token\'s smallest unit, as a decimal string' },
      },
      required: ['asset', 'payee', 'amount'],
    },
    capability: { id: 'treasury.payment.execute', action: 'execute', resourceArg: 'asset' },
    risk: 'high',
  },
  {
    id: 'organization.team.create',
    description: 'Create (charter) a new TEAM under a workspace or organization. The team becomes a typed agent named <label>.team, custodied by the connected user and stewarded by the workspace. Requires a mandate from the workspace. Args: workspace (the parent SA address — the mandate\'s delegator), label (the team\'s name: lowercase letters, digits, hyphens; omit if the ask did not name it — the person will be asked).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'The parent workspace / organization SA address' },
        label: { type: 'string', description: 'The team name label (a-z, 0-9, hyphen). Omit when the ask did not say it.' },
      },
      required: ['workspace'],
    },
    capability: { id: 'organization.team.create', action: 'create', resourceArg: 'workspace' },
    risk: 'medium',
  },
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

export const TEAM_LABEL_PATTERN = '^[a-z0-9-]{3,63}$';

/** What the Worker supplies for a team's genesis — the substrate the Home ceremony already uses, behind a
 *  port so the protocol (ask → derive → check → submit) is testable without a chain. */
export interface TeamGenesisDeps {
  /** Does `credential` custody `person`? A chain read on the person's SA (isCustodian / hasPasskey). */
  isCustodianOf(person: Address, credential: CredentialV1): Promise<boolean>;
  /** Who `<label>.team` resolves to, if anyone. */
  resolveName(name: string): Promise<Address | null>;
  /** Predict the child and build its genesis userOp: initCode from (credential, salt); callData = declare
   *  type + register `<label>.team` + set primary + approve the stewardship digest (child → workspace). */
  build(input: { credential: CredentialV1; salt: bigint; label: string; workspace: Address; stewardship: { salt: bigint; validUntil: number } }): Promise<{ child: Address; name: string; userOp: GenesisUserOpJson; userOpHash: Hex; stewardship: DelegationWireV1 }>;
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
 * The team-create invoker. Reads the ask (args) and the answers (ctx.supplied); asks for what is missing;
 * derives the genesis deterministically from the intent so a resume rebuilds the same child; and on a
 * signed resume checks the signed userOp against what it derived — sender, initCode, callData, hash —
 * before submitting. `person` is the connected user (from the session): the credential MUST custody them.
 */
export function teamCreateInvoker(genesis: TeamGenesisDeps, env: HarnessEnv, presented: MandatePresentation, person: Address | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const wire = presented.wire as Delegation;
    const workspace = String(args.workspace ?? '').toLowerCase() as Address;
    if (workspace !== wire.delegator.toLowerCase()) throw new Error(`the team is chartered by the mandate's delegator (${wire.delegator}); the plan named ${workspace || 'no workspace'}`);
    if (!person) throw new Error('no connected user: a team is custodied by the connected user, and there is none on this run');

    const data = dataFor(ctx.supplied, stepRef);
    const rawLabel = String(data.label ?? args.label ?? '').trim().toLowerCase();
    const label = new RegExp(TEAM_LABEL_PATTERN).test(rawLabel) ? rawLabel : '';
    const credential = parseCredential(data.custodian);
    const ask = (fields: InputFieldV1[], prompt: string): never => {
      throw new InputRequired({ kind: 'data', stepRef, toolId, prompt, fields });
    };
    const labelField = (hint?: string): InputFieldV1 => ({ name: 'label', label: 'Team name', type: 'text', required: true, pattern: TEAM_LABEL_PATTERN, ...(hint ? { hint } : { hint: 'lowercase letters, digits and hyphens; becomes <name>.team' }) });
    const credentialField: InputFieldV1 = { name: 'custodian', label: 'Connected credential', type: 'credential', required: true, hint: 'the credential you are signed in with will custody the team' };
    if (!label || !credential) {
      const fields: InputFieldV1[] = [...(label ? [] : [labelField(rawLabel ? `"${rawLabel}" is not a valid team name` : undefined)]), ...(credential ? [] : [credentialField])];
      ask(fields, label ? 'Which credential will custody the team?' : 'What should the team be called?');
    }
    const name = `${label}.team`;
    if (!(await genesis.isCustodianOf(person, credential!))) throw new Error(`the supplied credential does not custody the connected user's agent ${person} — custody is always the connected user`);

    // Deterministic from the intent: the same ask derives the same child, so a resume rebuilds what was
    // signed, and a second identical ask finds the team already there instead of chartering a twin.
    const digest = intentDigest(ctx.intent);
    const salt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:team`)));
    const stewardshipSalt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:stewardship`)));
    // The stewardship grant's window starts where the mandate's does (a fixed point per mandate), so it too
    // is the same on every run of this ask.
    const enforcers = harnessEnforcers(env);
    const ts = wire.caveats.find((c) => c.enforcer.toLowerCase() === enforcers.timestamp.toLowerCase());
    if (!ts) throw new Error('the mandate carries no timestamp caveat');
    const validUntil = Number(decodeTimestampTerms(ts.terms as Hex).validAfter) + 365 * 24 * 3600;

    const g = await genesis.build({ credential: credential!, salt, label, workspace, stewardship: { salt: stewardshipSalt, validUntil } });
    if (await genesis.isDeployed(g.child)) {
      return { team: g.child, name: g.name, workspace, custodian: credential, person, stewardshipDelegation: g.stewardship, alreadyCreated: true };
    }
    // Taken by someone ELSE — the child this ask derives is not there yet, so the name is not ours.
    const holder = await genesis.resolveName(name);
    if (holder && holder.toLowerCase() !== g.child.toLowerCase()) ask([labelField(`${name} is already taken — pick another name`)], `${name} is already taken. What should the team be called instead?`);

    const signed = signatureFor(ctx.supplied, stepRef);
    if (!signed) {
      throw new InputRequired({
        kind: 'signature', stepRef, toolId,
        prompt: `Sign the genesis of ${g.name} — a team under ${workspace}, custodied by you.`,
        digest: g.userOpHash, signer: signerOf(credential!),
        payload: { child: g.child, name: g.name, workspace, userOp: g.userOp },
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
    if (signed.signer.toLowerCase() !== signerOf(credential!).toLowerCase()) throw new Error('the signature is not from the credential that will custody the team');
    const { txHash } = await genesis.submit({ ...op, signature: signed.signature as Hex });
    return { txHash, team: g.child, name: g.name, workspace, custodian: credential, person, stewardshipDelegation: g.stewardship };
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
 * W2 approval port: approvals arrive WITH the ask, pre-signed by an approver. Each must (1) be over this
 * step's authority digest, (2) verify ERC-1271 against the approver, (3) come from a party the obligation
 * names. Anything short of all three is a refusal, not a pending — there is no one to wait for.
 */
export function suppliedApprovalsPort(deps: HarnessDeps, env: HarnessEnv, approvals: SuppliedApprovalV1[]): ApprovalPort {
  const validator = env.UNIVERSAL_SIGNATURE_VALIDATOR as Address | undefined;
  return {
    async request(req) {
      const want = approvalDigestFor({ stepRef: req.stepRef, mandateRef: req.evidence.mandateRef, intentDigest: req.evidence.intentDigest, capability: req.step.capability.id, action: req.step.capability.action, ...(req.step.capability.resource ? { resource: req.step.capability.resource } : {}) });
      const records: string[] = [];
      for (const ob of req.obligations) {
        const allowed = (ob.dischargeableBy.agents ?? []).map((a) => a.toLowerCase());
        const candidates = approvals.filter((a) => a.digest.toLowerCase() === want.toLowerCase() && (allowed.length === 0 || allowed.includes(a.approver.toLowerCase())));
        let discharged = false;
        for (const a of candidates) {
          if (!validator) break;
          const ok = await deps.readContract({ address: validator, abi: universalSignatureValidatorAbi, functionName: 'isValidSig', args: [a.approver, a.digest, a.signature] }).catch(() => false);
          if (ok === true) { records.push(`approval:${a.approver.toLowerCase()}:${a.digest}`); discharged = true; break; }
        }
        if (!discharged) return { status: 'refused', reason: `obligation ${ob.kind} (${ob.imposedBy}) not discharged: no valid approval over this step's authority digest from a permitted approver` };
      }
      return { status: 'discharged', records };
    },
  };
}

/** The invoker: informational tools go to the existing MCP path; the payment tool redeems on chain; the
 *  team tool builds a genesis the connected user signs. */
export function harnessInvoker(deps: HarnessDeps, env: HarnessEnv, presented: MandatePresentation, mcpInvoke: ToolInvoker, person?: Address): ToolInvoker {
  return async (toolId, args, ctx) => {
    if (toolId === 'organization.team.create') {
      if (!deps.teamGenesis) throw new Error('organization.team.create is not configured on this agent (no genesis substrate)');
      return teamCreateInvoker(deps.teamGenesis, env, presented, person)(toolId, args, ctx);
    }
    if (toolId !== 'treasury.payment.execute') return mcpInvoke(toolId, args, ctx);
    const serviceSa = (env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    const dm = env.DELEGATION_MANAGER as Address;
    const enforcers = harnessEnforcers(env);
    if (!enforcers.payment) throw new Error('harness: PAYMENT_ENFORCER is not configured');
    const asset = String(args.asset).toLowerCase() as Address;
    const payee = String(args.payee) as Address;
    const amount = BigInt(String(args.amount));
    const wire = presented.wire as Delegation;
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
    const paymentArgs = encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [digest, nonce, keccak256(toBytes(`${presented.ref}:${stepRef}`))]);
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
  presented: DelegationWireV1;
  approvals?: SuppliedApprovalV1[];
  /** Spec 350 §3.4 — answers to the prompts an earlier run of this ask raised (a resume). */
  supplied?: SuppliedInputV1[];
  /** The connected user (the session's SA). What they create, they custody. */
  person?: Address;
  runRef?: string;
  /** The MCP-backed invoker for informational tools (the existing orchestrate path). */
  mcpInvoke: ToolInvoker;
}

/** Run one ask under a mandate. Everything the loop decided is on the receipts; nothing here re-decides. */
export async function runUnderMandate(env: HarnessEnv, deps: HarnessDeps, input: HarnessRunInput): Promise<{ result: RunResult; plannerKind: string }> {
  const chainId = Number(env.CHAIN_ID);
  const dm = env.DELEGATION_MANAGER as Address;
  const enforcers = harnessEnforcers(env);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const wire = wireToDelegation(input.presented);
  const presented: MandatePresentation = { ref: hashDelegation(wire, chainId, dm), wire };
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
  const tools = [...ORCHESTRATION_TOOLS, ...HARNESS_ACTION_TOOLS];
  const result = await runIntent(input.intent, {
    planner, tools,
    invoke: harnessInvoker(deps, env, presented, input.mcpInvoke, input.person),
    ports: { mandateVerifier: verifier, policyEvaluator: policy, approvalPort: suppliedApprovalsPort(deps, env, input.approvals ?? []), receiptSink },
    presented,
    ...(input.supplied ? { supplied: input.supplied } : {}),
    ...(input.runRef ? { runRef: input.runRef } : {}),
    now,
  });
  return { result, plannerKind: kind };
}
