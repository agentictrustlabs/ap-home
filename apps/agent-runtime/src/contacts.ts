// CONTACTS — membership on the PERSON agent (spec 401 C1). A contact is an agent the person has let in: a friend, a
// coach service, an outside runtime, an assistant. Admitted by the person with a scoped grant (person → contact, what
// the contact may read of theirs), recorded in the person's OWN vault as `contact:<sa>` — its own record family with
// its own scope (`vault:contact:*`, read+write on the person's interactions grant), because the organization's
// invitation key stays a delivery-plane write (fabric's firewall) — revocable by the person: remove = revoke the grant
// on chain, one act. Standing (353 S5) reads the contact record the way it reads an org's admission.
//
// Nothing about a contact is public (ADR-0025). The ROLE (friend · family · coach · assistant · runtime · other) is
// declarative and authorizes nothing (as a household's kinship facets, spec 368); the grant is the authority.
//
// THE SAME MECHANISM, THE PERSON'S WORD. `person.contact.invite` is the organization's invitation with the person as
// the principal: the mandate's delegator is the person themselves (self — canGrant), the grant is theirs to the
// contact, the record lands in their vault. The invoker below is thin on purpose; what differs is named.
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { InputRequired, signatureFor, type ToolInvoker, type ToolSpec, type MandatePresentation, type SuppliedInputV1 } from '@agenticprimitives/orchestration';
import { buildCaveat, buildVaultRecordScopeCaveat, encodeTimestampTerms, encodeValueTerms, decodeTimestampTerms, hashDelegation, intentDigest, ROOT_AUTHORITY, type Caveat, type Delegation } from '@agenticprimitives/delegation';
import type { DelegationWireV1 } from '@agenticprimitives/a2a';

export const CONTACT_INVITE_CAPABILITY = 'person.contact.invite' as const;
export const CONTACT_LIST_CAPABILITY = 'person.contact.list' as const;
export const CONTACT_REMOVE_CAPABILITY = 'person.contact.remove' as const;

export const CONTACT_ROLES = ['friend', 'family', 'coach', 'assistant', 'runtime', 'other'] as const;
export type ContactRole = typeof CONTACT_ROLES[number];

/** What a contact may read of the person: their contact profile. Messaging needs no grant (an inbox is the
 *  recipient's); a coach's study records are the card room's own grant, referenced from the contact, not folded in. */
export const CONTACT_RESOURCE_SCOPE = 'vault:profile.contact';

export const CONTACT_INVITE_TOOL: ToolSpec = {
  id: CONTACT_INVITE_CAPABILITY,
  verbs: ['add as a contact', 'add contact', 'add to my contacts', 'make a contact', 'befriend'],
  establishes: 'submission',
  description:
    'ADD AN AGENT TO YOUR CONTACTS — a person, a coach service, an outside runtime, an assistant. Requires your own mandate '
    + '(it is your act, on your own records). Produces a signed access grant from you to the contact (they may read your '
    + 'contact profile) and records them in your contacts with a role. Args: contact (who — EXACTLY as the ask names them: '
    + 'a name, a typed name like bob.me or goose-1.svc, or an address; the agent resolves it), role (friend | family | coach '
    + '| assistant | runtime | other; default friend). NEVER for organizations — inviting someone to an organization is '
    + 'organization.membership.invite, asked at the organization.',
  inputSchema: {
    type: 'object',
    properties: {
      contact: { type: 'string', description: 'Who to add, as the ask names them (a name, a typed name, or an address)' },
      role: { type: 'string', description: 'friend | family | coach | assistant | runtime | other (default friend)' },
      person: { type: 'string', description: 'Whose contacts — the person asking (their own agent). Omit: it is always the asker.' },
    },
    required: ['contact'],
  },
  // The ACTING party is the person (their own mandate — self). Without an authorityArg the delegator falls through to
  // the RESOURCE (the contact) and the person is asked to sign as someone else: the failure messaging's `sender` closed.
  capability: { id: CONTACT_INVITE_CAPABILITY, action: 'invite', resourceArg: 'contact', authorityArg: 'person' },
  risk: 'medium',
};

export const CONTACT_LIST_TOOL: ToolSpec = {
  id: CONTACT_LIST_CAPABILITY,
  answers: ['my contacts', 'who are my contacts', 'contacts', 'who have i added', 'my coach', 'my runtimes'],
  description:
    'YOUR CONTACTS — the agents you have let in (people, coaches, runtimes, assistants), each with their role and '
    + 'whether their access grant stands. Your own records only. Args: none.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};

export const CONTACT_REMOVE_TOOL: ToolSpec = {
  id: CONTACT_REMOVE_CAPABILITY,
  verbs: ['remove contact', 'remove from my contacts', 'drop contact', 'fire', 'unfriend'],
  establishes: 'submission',
  description:
    'REMOVE A CONTACT — revokes the access grant you gave them on chain (one act: they stop being able to read your '
    + 'contact profile at the next gate) and marks them removed in your contacts. Requires your own mandate. Args: '
    + 'contact (who, as the ask names them).',
  inputSchema: { type: 'object', properties: { contact: { type: 'string', description: 'Who to remove, as the ask names them' }, person: { type: 'string', description: 'Whose contacts — the person asking. Omit.' }, manager: { type: 'string', description: 'The delegation manager the revocation is a call to — filled by the agent, never by the planner.' } }, required: ['contact'] },
  // Remove IS a revocation: a call to the DelegationManager (the RESOURCE, as access.grant.revoke declares it); which grant
  // dies travels in the calldata — the contact is resolved as a party (its role below) but is not the caveat's location.
  capability: { id: CONTACT_REMOVE_CAPABILITY, action: 'revoke', resourceArg: 'manager', authorityArg: 'person', redeemsOnChain: true }, // spec 408 §2.2: redeemed through the DM
  risk: 'medium',
};

/** The person's record of a contact — `contact:<sa>` in their own vault (standing reads it), with the role. */
export interface ContactRecordV1 {
  type: 'ap.contact.v1';
  contact: Address;
  role: ContactRole;
  /** The person → contact access grant (what the contact may read). */
  delegation: DelegationWireV1;
  grantDigest: Hex;
  status: 'contact' | 'removed';
  createdAt: number;
  removedAt?: number;
  /** A person contact is mutual once they add you back; an agent contact is one-way (it has no roster). */
  mutual?: boolean;
}

export const CONTACT_RECORD_PREFIX = 'contact:';
export const contactRecordType = (contact: string): string => `${CONTACT_RECORD_PREFIX}${contact.toLowerCase()}`;

export interface ContactDeps {
  env: { CHAIN_ID?: string; DELEGATION_MANAGER?: string; HARNESS_AGENT_SA?: string; VAULT_SERVER_ID?: string; TIMESTAMP_ENFORCER?: string; VALUE_ENFORCER?: string; DIGEST_BINDING_ENFORCER?: string; CONTRACTS_GENERATION?: string };
  enforcers: { timestamp: Address; value: Address; digestBinding: Address };
  vaultServerId: string;
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  survey?: (subject: string) => Promise<Array<{ recordType: string }>>;
  readRecords?: (subject: string, recordTypes: string[]) => Promise<Record<string, unknown>>;
  nameOf?: (address: string) => Promise<string | null>;
  agentTypeOf?: (address: string) => Promise<string | null>;
  sendDirectMessage?: (input: { sender: Address; recipient: Address; bodyText: string; session: string; contextRefs?: Array<{ kind: string; id: string; label?: string }> }) => Promise<{ ok: boolean; error?: string; messageId?: string }>;
  /** The person's SA executes a call under their redeemed mandate (the revoke) — the same path access.grant.revoke uses. */
  executeAsServiceSa?: (serviceSa: Address, callData: Hex) => Promise<{ txHash: string }>;
  /** The mandate's digest-binding caveat argued for THIS step (the harness's own helper, injected). */
  digestBindingArgsFor: (caveat: Caveat, digests: { intent: Hex; offer?: Hex; projection?: Hex; plan?: Hex; stepNonce: Hex; generation?: 1 | 2 }) => Hex;
  /** Spec 408 §1.4/§2.3 — the digests a step presents at redemption, with its single-use nonce, the plan digest and
   *  the estate's contract generation (1 ⇒ the digest alone). */
  stepDigests: (args: Record<string, unknown>, intent: Hex, stepRef: string, plan?: Hex, generation?: 1 | 2) => { intent: Hex; offer?: Hex; projection?: Hex; plan?: Hex; stepNonce: Hex; generation: 1 | 2 };
}

const roleOf = (raw: unknown): ContactRole => {
  const r = String(raw ?? '').trim().toLowerCase();
  return (CONTACT_ROLES as readonly string[]).includes(r) ? (r as ContactRole) : 'friend';
};

function buildContactGrant(deps: ContactDeps, person: Address, contact: Address, salt: bigint, validUntil: number): Delegation {
  const caveats: Caveat[] = [
    buildVaultRecordScopeCaveat([{ server: deps.vaultServerId, resources: [CONTACT_RESOURCE_SCOPE], ops: ['read'] }]),
    buildCaveat(deps.enforcers.timestamp, encodeTimestampTerms(0, validUntil)),
    buildCaveat(deps.enforcers.value, encodeValueTerms(0n)),
  ];
  return { delegator: person, delegate: contact, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
}

/** `person.contact.invite` — the person's own act, on their own records. */
export function contactInviteInvoker(deps: ContactDeps, presented: MandatePresentation, person: Address | undefined, session: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!person) throw new Error('contacts are a person\'s own — there is no person on this run');
    const wire = presented.wire as Delegation;
    if (wire.delegator.toLowerCase() !== person.toLowerCase()) throw new Error(`a contact is added under your own mandate (${person}); the mandate is from ${wire.delegator}`);
    const contact = String(args.contact ?? '').toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(contact)) {
      throw new InputRequired({ kind: 'data', stepRef, toolId, prompt: 'Who should be added? Give their agent name or address.', fields: [{ name: 'contact', label: 'Contact', type: 'text', required: true, hint: 'a typed name (bob.me, goose-1.svc) or an address' }] });
    }
    if (contact === person.toLowerCase()) throw new Error('you are not your own contact');
    const kind = deps.agentTypeOf ? await deps.agentTypeOf(contact).catch(() => null) : null;
    if (kind === 'org') throw new Error('an organization is not a contact — you belong to it (or not); ask it to invite you');
    const role = roleOf(args.role);
    if (!deps.writeSubjectRecord || !deps.readSubjectRecord) throw new Error('this agent cannot keep contacts');
    const me = person.toLowerCase();
    const existing = (await deps.readSubjectRecord(me, contactRecordType(contact)).catch(() => null)) as ContactRecordV1 | null;
    if (existing?.type === 'ap.contact.v1' && existing.status === 'contact') {
      return { added: false, contact, role: existing.role, alreadyContact: true, grantDigest: existing.grantDigest, note: 'already among your contacts — nothing changed' };
    }
    // the grant, signed by the person (the second prompt of a two-prompt path in C1; the one-prompt fold is C2's)
    const digest = intentDigest(ctx.intent);
    const ts = wire.caveats.find((c) => c.enforcer.toLowerCase() === deps.enforcers.timestamp.toLowerCase());
    if (!ts) throw new Error('the mandate carries no timestamp caveat');
    const validUntil = Number(decodeTimestampTerms(ts.terms as Hex).validAfter) + 365 * 24 * 3600;
    const salt = BigInt(keccak256(toBytes(`${digest}:${stepRef}:contact:${contact}`)));
    const grant = buildContactGrant(deps, person, contact, salt, validUntil);
    const grantDigest = hashDelegation(grant, Number(deps.env.CHAIN_ID), deps.env.DELEGATION_MANAGER as Address);
    const signed = signatureFor(ctx.supplied as readonly SuppliedInputV1[] | undefined, stepRef, grantDigest);
    if (!signed) {
      throw new InputRequired({ kind: 'signature', stepRef, toolId, prompt: `Sign the contact grant from you to ${contact} — it lets them read your contact profile.`, digest: grantDigest, signer: person, payload: { contact, role, scope: CONTACT_RESOURCE_SCOPE, validUntil } });
    }
    const delegation: DelegationWireV1 = { ...grant, salt: salt.toString(), signature: signed.signature as Hex };
    let mutual: boolean | undefined;
    if (kind === 'person') {
      const inbox = (await deps.readSubjectRecord(me, 'inbox.data').catch(() => null)) as { envelopes?: Array<{ from?: string; contextRefs?: Array<{ kind: string; id: string }> }> } | null;
      mutual = (inbox?.envelopes ?? []).some((e) => (String(e.from ?? '').match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() === contact && (e.contextRefs ?? []).some((r) => r.kind === 'contact' && r.id.toLowerCase() === me));
    }
    const record: ContactRecordV1 = { type: 'ap.contact.v1', contact, role, delegation, grantDigest, status: 'contact', createdAt: Date.now(), ...(mutual !== undefined ? { mutual } : {}) };
    const wrote = await deps.writeSubjectRecord(me, contactRecordType(contact), record);
    if (!wrote.ok) throw new Error(`the contact could not be recorded: ${wrote.error ?? 'write refused'}`);
    // WHAT FOLLOWS (spec 360): the contact is TOLD — a message from the person carrying the reference the Home renders
    // as "accept" (a person adds you back; an agent needs nothing). An effect never fails the act; it is reported.
    let told: { ok: boolean; error?: string } = { ok: false, error: 'the contact was not told — telling them is a message sent as you, which needs your session' };
    if (session && deps.sendDirectMessage) {
      told = await deps.sendDirectMessage({ sender: person, recipient: contact, bodyText: kind === 'person' ? `I've added you to my contacts as ${role}. Add me back and we're mutual.` : `You're now in my contacts as ${role}.`, session, contextRefs: [{ kind: 'contact', id: me, label: 'Add back' }] }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
    return { added: true, contact, role, grantDigest, delegation, told, kind: kind ?? 'unknown', ...(mutual !== undefined ? { mutual } : {}), note: kind === 'person' ? (mutual ? 'recorded in your contacts — mutual: they had already added you' : 'recorded in your contacts; mutual once they add you back') : 'recorded in your contacts' };
  };
}

/** `person.contact.list` — the person's own roster of contacts. A read of their own records; no mandate. */
export function contactListInvoker(deps: ContactDeps, person: Address | undefined): ToolInvoker {
  return async () => {
    if (!person) return { refused: 'contacts are a person\'s own — there is no person on this run' };
    if (!deps.survey || !deps.readRecords) return { refused: 'this agent cannot read its contacts here' };
    const me = person.toLowerCase();
    const keys = (await deps.survey(me).catch(() => [])).map((r) => r.recordType).filter((rt) => rt.startsWith(CONTACT_RECORD_PREFIX)).slice(0, 200);
    const bodies: Record<string, unknown> = keys.length ? await deps.readRecords(me, keys).catch(() => ({} as Record<string, unknown>)) : {};
    const contacts: Array<{ contact: string; name: string | null; role: string; status: string; grantDigest?: string; mutual?: boolean; since?: string }> = [];
    for (const rt of keys) {
      const rec = bodies[rt] as ContactRecordV1 | undefined;
      if (rec?.type !== 'ap.contact.v1') continue;
      contacts.push({ contact: rec.contact, name: deps.nameOf ? await deps.nameOf(rec.contact).catch(() => null) : null, role: rec.role, status: rec.status, grantDigest: rec.grantDigest, ...(rec.mutual !== undefined ? { mutual: rec.mutual } : {}), since: new Date(rec.createdAt).toISOString() });
    }
    // MUTUAL, from evidence in the person's OWN vault: a person contact who added them back sent a message carrying a
    // `contact` reference (the invoker below tells the contact that way). Nobody reads another's contact list.
    const inbox = (await deps.readSubjectRecord?.(me, 'inbox.data').catch(() => null)) as { envelopes?: Array<{ from?: string; contextRefs?: Array<{ kind: string; id: string }> }> } | null;
    const addedMeBack = new Set((inbox?.envelopes ?? []).filter((e) => (e.contextRefs ?? []).some((r) => r.kind === 'contact' && r.id.toLowerCase() === me)).map((e) => (String(e.from ?? '').match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase()));
    for (const c of contacts) if (c.mutual === false && addedMeBack.has(c.contact.toLowerCase())) c.mutual = true;
    const current = contacts.filter((c) => c.status === 'contact');
    return { count: current.length, contacts: current, removed: contacts.length - current.length, interpretation: `read the person's own contacts (${contacts.length} record(s))`, note: current.length ? 'Your contacts, from your own records; the role is declarative — the grant is what each may read.' : 'No contacts yet — "add bob.me as a contact".' };
  };
}

const REVOKE_BY_OWNER_ABI = [{ type: 'function', name: 'revokeDelegationByOwner', stateMutability: 'nonpayable', inputs: [{ name: 'delegation', type: 'tuple', components: [{ name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] }], outputs: [] }] as const;
const REDEEM_ABI = [{ type: 'function', name: 'redeemDelegation', stateMutability: 'nonpayable', inputs: [{ name: 'delegations', type: 'tuple[]', components: [{ name: 'delegator', type: 'address' }, { name: 'delegate', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'tuple[]', components: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }, { name: 'args', type: 'bytes' }] }, { name: 'salt', type: 'uint256' }, { name: 'signature', type: 'bytes' }] }, { name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] }] as const;

/** `person.contact.remove` — revoke the grant on chain (the person's SA, under their mandate) and mark the record removed. */
export function contactRemoveInvoker(deps: ContactDeps, presented: MandatePresentation, person: Address | undefined): ToolInvoker {
  return async (_toolId, args, ctx) => {
    if (!person) throw new Error('contacts are a person\'s own — there is no person on this run');
    const wire = presented.wire as Delegation;
    if (wire.delegator.toLowerCase() !== person.toLowerCase()) throw new Error(`a contact is removed under your own mandate (${person}); the mandate is from ${wire.delegator}`);
    const contact = String(args.contact ?? '').toLowerCase() as Address;
    if (!/^0x[0-9a-f]{40}$/.test(contact)) throw new Error(`the contact did not resolve to an agent (${String(args.contact ?? '')})`);
    if (!deps.readSubjectRecord || !deps.writeSubjectRecord) throw new Error('this agent cannot keep contacts');
    const me = person.toLowerCase();
    const rec = (await deps.readSubjectRecord(me, contactRecordType(contact)).catch(() => null)) as ContactRecordV1 | null;
    if (rec?.type !== 'ap.contact.v1' || rec.status !== 'contact') return { removed: false, contact, note: 'not among your contacts — nothing to remove' };
    if (!deps.executeAsServiceSa) throw new Error('this agent cannot revoke on chain here');
    const g = rec.delegation;
    const inner = encodeFunctionData({ abi: REVOKE_BY_OWNER_ABI, functionName: 'revokeDelegationByOwner', args: [{ delegator: g.delegator as Address, delegate: g.delegate as Address, authority: g.authority as Hex, caveats: g.caveats.map((c) => ({ enforcer: c.enforcer as Address, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex })), salt: BigInt(g.salt), signature: g.signature as Hex }] });
    const dm = deps.env.DELEGATION_MANAGER as Address;
    const serviceSa = (deps.env.HARNESS_AGENT_SA ?? '').toLowerCase() as Address;
    const digest = intentDigest(ctx.intent);
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const caveats = wire.caveats.map((c) => (c.enforcer.toLowerCase() === deps.enforcers.digestBinding.toLowerCase()
      ? { enforcer: c.enforcer, terms: c.terms as Hex, args: deps.digestBindingArgsFor(c as Caveat, deps.stepDigests(args, digest, stepRef, ctx.planDigest as Hex | undefined, deps.env.CONTRACTS_GENERATION === '2' ? 2 : 1)) }
      : { enforcer: c.enforcer, terms: c.terms as Hex, args: (c.args ?? '0x') as Hex }));
    const redeem = encodeFunctionData({ abi: REDEEM_ABI, functionName: 'redeemDelegation', args: [[{ delegator: wire.delegator, delegate: wire.delegate, authority: wire.authority as Hex, caveats, salt: wire.salt, signature: wire.signature as Hex }], dm, 0n, inner] });
    const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dm, 0n, redeem] });
    const { txHash } = await deps.executeAsServiceSa(serviceSa, callData);
    const next: ContactRecordV1 = { ...rec, status: 'removed', removedAt: Date.now() };
    const wrote = await deps.writeSubjectRecord(me, contactRecordType(contact), next);
    return { removed: true, contact, role: rec.role, grantDigest: rec.grantDigest, txHash, recorded: wrote.ok, note: 'the grant is revoked on chain — every gate refuses it from the next request; the contact is marked removed in your records' };
  };
}
