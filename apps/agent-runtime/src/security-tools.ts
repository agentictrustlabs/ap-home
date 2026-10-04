// THE SECURITY SECTION, ASKED — spec 422 §9.1 and the owner's rule (2026-10-01): the Ask performs every feature the
// section's buttons perform and answers every question its pages answer. Two reads and four acts, all SELF-ACTING
// (the person's own account and her own vault; no mandate — `selfAuthorized`):
//
//   person.credentials.list   what signs for her / what only opens her home   (the Sign-in page's list)
//   person.security.posture   how protected her home is                        (the Overview's posture card)
//   person.credential.add     a passkey or wallet that signs for her          — a CEREMONY her Home runs under her credential
//   person.credential.label   rename a credential                              — a vault write her Home runs
//   person.channel.link       an email or phone that opens her home           — a CEREMONY (the code she verifies)
//   person.channel.unlink     an email or phone stops opening it              — her Home tombstones the facet
//
// THE CHAIN DECIDES what signs (`hasPasskey` / `isCustodian`); her vault (`security.credentials`) only labels it, and
// `security.channels` lists what opens the home. Every act follows the org-join shape (spec 421): the invoker asks for
// a CONFIRMATION naming the ceremony; her Home runs the same code the button runs; on resume the invoker reads her
// records back and says what happened — this runtime never claims a ceremony it did not witness.
import { InputRequired, type ToolSpec, type ToolInvoker } from '@agenticprimitives/orchestration';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { ADAPTER } from './adapter-declarations.js';

export const CREDENTIALS_LIST_CAPABILITY = 'person.credentials.list' as const;
export const SECURITY_POSTURE_CAPABILITY = 'person.security.posture' as const;
export const CREDENTIAL_ADD_CAPABILITY = 'person.credential.add' as const;
export const CREDENTIAL_LABEL_CAPABILITY = 'person.credential.label' as const;
export const CHANNEL_LINK_CAPABILITY = 'person.channel.link' as const;
export const CHANNEL_UNLINK_CAPABILITY = 'person.channel.unlink' as const;

export const CREDENTIALS_RECORD = 'security.credentials' as const;
export const CHANNELS_RECORD = 'security.channels' as const;

// ── Records, as the Home writes them (apps/home/src/home/credentials.ts) ──────────────────────────────────
export type CredentialRef = { kind: 'passkey'; credentialIdDigest: Hex } | { kind: 'custodian'; address: Address };
export interface CredentialLabelV1 { ref: CredentialRef; label: string; device?: string; method?: 'google' | 'email' | 'phone' | 'youversion'; createdAt: string; state?: string; retiredAt?: string }
export interface ChannelV1 { kind: 'email' | 'phone'; value: string; linkedAt: string; unlinkedAt?: string }

export const CREDENTIALS_LIST_TOOL: ToolSpec = {
  id: CREDENTIALS_LIST_CAPABILITY,
  answers: ['what signs for me', 'which credentials sign for me', 'what can sign for me', 'my passkeys', 'my sign-in methods', 'how do i sign in', 'which devices can open my home', 'what opens my home', 'my credentials', 'is my phone a credential', 'can my email sign for me'],
  description:
    'WHICH CREDENTIALS SIGN FOR THE PERSON and which only open her home — her passkeys, wallets and the server-held key behind '
    + 'a Google / email / phone home (custody-grade: they SIGN), and the emails and phones that only OPEN it (login-grade: told '
    + 'about changes, never signers). Use it for "what signs for me", "my passkeys", "can my phone sign for me". Her own '
    + 'home only. Args: none.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};

export const SECURITY_POSTURE_TOOL: ToolSpec = {
  id: SECURITY_POSTURE_CAPABILITY,
  answers: ['how secure is my home', 'how protected am i', 'am i protected', 'what happens if i lose my phone', 'what if i lose my passkey', 'can i recover my home', 'do i have a backup', 'is my home recoverable', 'who can recover my home', 'my recovery'],
  description:
    'HOW PROTECTED THE PERSON\'S HOME IS — how many credentials sign for it and of which kinds, whether a lost device is '
    + 'survivable, whether recovery trustees are named, and the one next step. Use it for "what happens if I lose my phone", '
    + '"how protected am I", "can I recover my home". Her own home only. Args: none.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
};

export const CREDENTIAL_ADD_TOOL: ToolSpec = {
  id: CREDENTIAL_ADD_CAPABILITY,
  verbs: ['add a passkey', 'add a wallet', 'add a credential', 'add a backup', 'add a second passkey', 'add my wallet', 'create a passkey'],
  description:
    'ADDS A CREDENTIAL THAT SIGNS FOR THE PERSON — a passkey on this device or a connected wallet — by the same ceremony as '
    + 'the Add button on her Home\'s Sign-in page, signed by a credential that already signs for her. Adding changes nothing she '
    + 'has granted. Args: kind (passkey | wallet), label (a name for it, optional).',
  inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['passkey', 'wallet'], description: 'passkey (this device) or wallet' }, label: { type: 'string', description: 'A name for the credential' } }, required: ['kind'] },
  capability: { id: CREDENTIAL_ADD_CAPABILITY, action: 'add' },
  risk: 'high', adapter: ADAPTER.sync,
  selfAuthorized: true,
  dryRun: 'invoke',
  establishes: 'authoritative',
  interaction: { navigationTarget: 'security-sign-in' },
};

export const CREDENTIAL_LABEL_TOOL: ToolSpec = {
  id: CREDENTIAL_LABEL_CAPABILITY,
  verbs: ['rename', 'rename my passkey', 'rename my wallet', 'call my passkey', 'label my credential', 'name my passkey'],
  description:
    'RENAMES ONE OF THE PERSON\'S CREDENTIALS — a label in her vault; the chain only knows the key. Args: credential (words that '
    + 'name the one to rename — its current label, "this device", or "my wallet"), label (the new name).',
  inputSchema: { type: 'object', properties: { credential: { type: 'string', description: 'Which credential, by its current label or "this device"' }, label: { type: 'string', description: 'The new name' } }, required: ['credential', 'label'] },
  capability: { id: CREDENTIAL_LABEL_CAPABILITY, action: 'label' },
  risk: 'low', adapter: ADAPTER.sync,
  selfAuthorized: true,
  dryRun: 'invoke',
  establishes: 'authoritative',
  interaction: { navigationTarget: 'security-sign-in' },
};

export const CHANNEL_LINK_TOOL: ToolSpec = {
  id: CHANNEL_LINK_CAPABILITY,
  verbs: ['add my email', 'add my phone', 'link my email', 'link my phone', 'add an email', 'add a phone', 'add a phone number'],
  description:
    'LINKS AN EMAIL OR PHONE TO THE PERSON\'S HOME so it OPENS the home and is TOLD about changes. She verifies a code at her '
    + 'Home (the same ceremony as the Add email / Add phone buttons). A channel never signs for her, never approves, never '
    + 'recovers. Args: kind (email | phone), channel (the address or number, optional — her Home asks for it).',
  inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['email', 'phone'] }, channel: { type: 'string', description: 'The email address or phone number' } }, required: ['kind'] },
  capability: { id: CHANNEL_LINK_CAPABILITY, action: 'link' },
  risk: 'low', adapter: ADAPTER.sync,
  selfAuthorized: true,
  dryRun: 'invoke',
  establishes: 'authoritative',
  interaction: { navigationTarget: 'security-sign-in' },
};

export const CHANNEL_UNLINK_TOOL: ToolSpec = {
  id: CHANNEL_UNLINK_CAPABILITY,
  verbs: ['unlink my email', 'unlink my phone', 'remove my email', 'remove my phone', 'remove my phone number', 'stop using my email', 'drop my phone'],
  description:
    'UNLINKS AN EMAIL OR PHONE FROM THE PERSON\'S HOME — it stops opening the home and stops being told about changes. '
    + 'Nothing on chain changes (a channel never signed). Args: kind (email | phone), channel (which one — the address or '
    + 'number, or its last digits; optional when she has only one of that kind).',
  inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['email', 'phone'] }, channel: { type: 'string', description: 'The address, the number, or its last digits' } }, required: ['kind'] },
  capability: { id: CHANNEL_UNLINK_CAPABILITY, action: 'unlink' },
  risk: 'low', adapter: ADAPTER.sync,
  selfAuthorized: true,
  dryRun: 'invoke',
  establishes: 'authoritative',
  interaction: { navigationTarget: 'security-sign-in' },
};

export const SECURITY_READ_TOOLS: ToolSpec[] = [CREDENTIALS_LIST_TOOL, SECURITY_POSTURE_TOOL];
export const SECURITY_ACT_TOOLS: ToolSpec[] = [CREDENTIAL_ADD_TOOL, CREDENTIAL_LABEL_TOOL, CHANNEL_LINK_TOOL, CHANNEL_UNLINK_TOOL];
export const SECURITY_ACTS = new Set(SECURITY_ACT_TOOLS.map((t) => t.id));
export const isSecurityTool = (id: string): boolean => SECURITY_READ_TOOLS.some((t) => t.id === id) || SECURITY_ACTS.has(id);

// ── Deps ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface SecurityDeps {
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  /** The chain's counts: custodians (wallets + server-held keys) and passkeys. */
  readCounts: (person: Address) => Promise<{ custodians: number; passkeys: number }>;
  /** Is this credential in the account's set right now? */
  readPresence: (person: Address, ref: CredentialRef) => Promise<boolean>;
  /** 0 = self-governed; 1–3 = custody-governed (spec 207 §4). */
  readCustodyMode: (person: Address) => Promise<number>;
}

const METHOD_WORDS: Record<NonNullable<CredentialLabelV1['method']>, string> = { google: 'Google', email: 'email', phone: 'phone (SMS)', youversion: 'YouVersion' };
export const refKey = (r: CredentialRef): string => r.kind === 'passkey' ? `passkey:${r.credentialIdDigest.toLowerCase()}` : `custodian:${r.address.toLowerCase()}`;
export const maskChannel = (c: Pick<ChannelV1, 'kind' | 'value'>): string => {
  if (c.kind === 'email') { const [u, d] = c.value.split('@'); return u && d ? `${u.slice(0, 2)}…@${d}` : c.value; }
  const digits = c.value.replace(/\D/g, ''); return digits.length >= 4 ? `…${digits.slice(-4)}` : c.value;
};

export interface CredentialItemV1 { grade: 'custody-grade' | 'login-grade'; kind: 'passkey' | 'wallet' | 'server-key' | 'email' | 'phone'; label: string; detail: string; state: 'active' | 'retired' | string }

/** PURE: labels ⊕ chain presence ⊕ counts ⊕ channels → the listing the Home's page shows (spec 422 §3.1). */
export function credentialItems(input: { labels: CredentialLabelV1[]; present: Map<string, boolean>; counts: { custodians: number; passkeys: number }; channels: ChannelV1[] }): { items: CredentialItemV1[]; unlabelled: { passkeys: number; custodians: number } } {
  const items: CredentialItemV1[] = [];
  let lp = 0, lc = 0;
  for (const l of input.labels) {
    const onChain = input.present.get(refKey(l.ref)) === true;
    const state = onChain ? 'active' : (l.state && l.state !== 'active' ? l.state : 'retired');
    if (onChain) { if (l.ref.kind === 'passkey') lp += 1; else lc += 1; }
    const kind: CredentialItemV1['kind'] = l.ref.kind === 'passkey' ? 'passkey' : l.method ? 'server-key' : 'wallet';
    const detail = kind === 'passkey' ? (l.device ?? 'a device') : kind === 'server-key' ? `the server-secured key behind her ${METHOD_WORDS[l.method!]} sign-in` : `wallet ${l.ref.kind === 'custodian' ? `${l.ref.address.slice(0, 6)}…${l.ref.address.slice(-4)}` : ''}`;
    items.push({ grade: 'custody-grade', kind, label: l.label, detail, state });
  }
  for (const c of input.channels) {
    if (c.unlinkedAt) continue;
    items.push({ grade: 'login-grade', kind: c.kind, label: c.kind === 'email' ? 'Email' : 'Phone (SMS)', detail: `${maskChannel(c)} · opens her home · told about changes · never signs`, state: 'active' });
  }
  return { items, unlabelled: { passkeys: Math.max(0, input.counts.passkeys - lp), custodians: Math.max(0, input.counts.custodians - lc) } };
}

export type PostureRung = 'just-you' | 'backups' | 'trustees';
/** PURE: the ladder (spec 422 §4.1 / 207 §4). */
export function postureOf(input: { counts: { custodians: number; passkeys: number }; kinds: Set<string>; custodyMode: number }): { rung: PostureRung; words: string; next: string } {
  const total = input.counts.custodians + input.counts.passkeys;
  if (input.custodyMode > 0) return { rung: 'trustees', words: 'recovery trustees are named: people she chose can restore her access after the safety delay, and she can stop a false recovery during its first day', next: 'keep at least three trustees so losing one still leaves a majority' };
  if (total >= 2 && (input.kinds.size >= 2 || input.counts.passkeys >= 2)) return { rung: 'backups', words: `${total} credentials sign for this home, of more than one kind: lose one, sign in with the other and replace it`, next: 'name recovery trustees (arrives with the Security section\'s recovery wave)' };
  return { rung: 'just-you', words: total === 1 ? 'one credential opens this home; lose it and nothing can bring it back' : total === 0 ? 'nothing signs for this home — it cannot act until a credential is added' : `${total} credentials of one kind sign for this home`, next: 'add a passkey on a second device or a wallet, so a lost device is survivable' };
}

async function readLabels(deps: SecurityDeps, person: string): Promise<CredentialLabelV1[] | null> {
  if (!deps.readSubjectRecord) return null;
  const rec = (await deps.readSubjectRecord(person, CREDENTIALS_RECORD).catch(() => null)) as { v?: number; items?: CredentialLabelV1[] } | null;
  return rec && rec.v === 1 && Array.isArray(rec.items) ? rec.items : [];
}
async function readChannels(deps: SecurityDeps, person: string): Promise<ChannelV1[] | null> {
  if (!deps.readSubjectRecord) return null;
  const rec = (await deps.readSubjectRecord(person, CHANNELS_RECORD).catch(() => null)) as { v?: number; items?: ChannelV1[] } | null;
  return rec && rec.v === 1 && Array.isArray(rec.items) ? rec.items : [];
}

function matchLabel(labels: CredentialLabelV1[], words: string): CredentialLabelV1[] {
  const w = words.trim().toLowerCase();
  if (!w) return [];
  return labels.filter((l) => (l.state ?? 'active') === 'active' && (l.label.toLowerCase().includes(w) || (l.device ?? '').toLowerCase().includes(w) || (w.includes('wallet') && l.ref.kind === 'custodian' && !l.method) || (w.includes('passkey') && l.ref.kind === 'passkey')));
}
function matchChannel(channels: ChannelV1[], kind: string, value: string): ChannelV1[] {
  const live = channels.filter((c) => !c.unlinkedAt && c.kind === kind);
  const v = value.trim().toLowerCase();
  if (!v) return live;
  const digits = v.replace(/\D/g, '');
  return live.filter((c) => c.value.toLowerCase() === v || maskChannel(c).toLowerCase() === v || (digits.length >= 4 && c.value.replace(/\D/g, '').endsWith(digits)));
}

export function securityInvoker(deps: SecurityDeps, person: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    if (!person) return { refused: 'the person\'s credentials are read from her own account and records, and there is no signed-in person on this run' };
    const me = person.toLowerCase() as Address;

    if (toolId === CREDENTIALS_LIST_CAPABILITY || toolId === SECURITY_POSTURE_CAPABILITY) {
      const unread: string[] = [];
      const [counts, mode, labels, channels] = await Promise.all([
        deps.readCounts(me).catch(() => { unread.push('the chain\'s credential set'); return null; }),
        deps.readCustodyMode(me).catch(() => { unread.push('the custody mode'); return 0; }),
        readLabels(deps, me).then((l) => { if (l === null) unread.push('her credential labels'); return l ?? []; }),
        readChannels(deps, me).then((c) => { if (c === null) unread.push('her channels'); return c ?? []; }),
      ]);
      if (!counts) return { refused: 'the chain could not be read just now, and what signs for her is the chain\'s to say — say so rather than guessing', unread };
      const present = new Map<string, boolean>();
      await Promise.all(labels.map(async (l) => { try { present.set(refKey(l.ref), await deps.readPresence(me, l.ref)); } catch { unread.push(`whether "${l.label}" is still on chain`); } }));
      const { items, unlabelled } = credentialItems({ labels, present, counts, channels });
      const custody = items.filter((i) => i.grade === 'custody-grade' && i.state === 'active');
      const note = (unread.length ? `Could not read ${unread.join(', ')} — say so rather than "nothing". ` : '')
        + 'Custody-grade credentials SIGN for her; an email or phone only opens her home and is told about changes — never a signer, never a recovery. Adding, replacing or retiring one is a ceremony at her Home\'s Sign-in page.';
      if (toolId === CREDENTIALS_LIST_CAPABILITY) {
        return {
          count: items.length, items, unlabelled, counts, custodyMode: mode,
          interpretation: 'read the chain for what signs for her and her vault for the labels and channels',
          note: (custody.length || unlabelled.passkeys + unlabelled.custodians ? `${custody.length} labelled credential${custody.length === 1 ? '' : 's'} sign${custody.length === 1 ? 's' : ''} for her${unlabelled.passkeys + unlabelled.custodians ? `, plus ${unlabelled.passkeys + unlabelled.custodians} the chain holds that her Home has no label for` : ''}. ` : 'Nothing signs for this home. ') + note,
        };
      }
      const kinds = new Set(custody.map((i) => i.kind));
      const posture = postureOf({ counts, kinds, custodyMode: mode });
      return {
        rung: posture.rung, counts, kinds: [...kinds], custodyMode: mode, channels: items.filter((i) => i.grade === 'login-grade').length,
        interpretation: 'read the chain for what signs for her and whether her account is custody-governed',
        note: `${posture.words}. Next step: ${posture.next}. ` + note + ' Her address and name never change — credentials rotate.',
      };
    }

    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    const confirmed = (ctx.supplied ?? []).some((x) => x.stepRef === stepRef && x.confirmed === true);

    if (toolId === CREDENTIAL_ADD_CAPABILITY) {
      const kind = String(args.kind ?? '').toLowerCase();
      if (kind !== 'passkey' && kind !== 'wallet') return { refused: 'a passkey or a wallet? name which kind of credential to add' };
      const label = String(args.label ?? '').trim() || (kind === 'passkey' ? 'Passkey' : 'Wallet');
      if (!confirmed) {
        // A comparison's dry run stops here too: the ceremony is hers to run, never simulated.
        throw new InputRequired({ kind: 'confirmation', stepRef, toolId, prompt: `Add a ${kind} named "${label}" that signs for your home? Your Home creates it and a credential that already signs for you authorizes it. Nothing you have granted changes.`, summary: { ceremony: 'credential-add', kind, label } });
      }
      const labels = (await readLabels(deps, me)) ?? [];
      const hit = labels.find((l) => l.label === label && (l.state ?? 'active') === 'active');
      const onChain = hit ? await deps.readPresence(me, hit.ref).catch(() => false) : false;
      return onChain
        ? { added: true, kind, label, answer: `"${label}" now signs for your home.` }
        : { refused: `the ${kind} "${label}" was not recorded on chain — nothing changed; the Add button on your Sign-in page does the same thing` };
    }

    if (toolId === CREDENTIAL_LABEL_CAPABILITY) {
      const words = String(args.credential ?? '');
      const label = String(args.label ?? '').trim();
      if (!label) return { refused: 'what should it be called? give the new name' };
      const labels = (await readLabels(deps, me)) ?? [];
      // RESUMED after the Home's ceremony: the old words no longer name anything — the record now carries the NEW label.
      // What happened is read from her records, never assumed from the confirmation.
      if (confirmed) {
        const now = labels.find((l) => (l.state ?? 'active') === 'active' && l.label === label);
        return now ? { renamed: true, from: words, label, answer: `"${words}" is now "${label}".` } : { refused: 'the new name was not recorded — nothing changed' };
      }
      const hits = matchLabel(labels, words);
      if (hits.length !== 1) return { refused: hits.length === 0 ? `no credential matches "${words}" — her labelled credentials are: ${labels.filter((l) => (l.state ?? 'active') === 'active').map((l) => l.label).join(', ') || 'none'}` : `"${words}" matches ${hits.length} credentials (${hits.map((l) => l.label).join(', ')}) — say which` };
      const target = hits[0]!;
      throw new InputRequired({ kind: 'confirmation', stepRef, toolId, prompt: `Rename "${target.label}" to "${label}"? A label in your vault; the key is unchanged.`, summary: { ceremony: 'credential-label', ref: target.ref, from: target.label, label } });
    }

    if (toolId === CHANNEL_LINK_CAPABILITY) {
      const kind = String(args.kind ?? '').toLowerCase();
      if (kind !== 'email' && kind !== 'phone') return { refused: 'an email or a phone? name which to link' };
      const value = String(args.channel ?? '').trim();
      if (!confirmed) throw new InputRequired({ kind: 'confirmation', stepRef, toolId, prompt: `Link ${value ? `${value} ` : `a${kind === 'email' ? 'n email' : ' phone'} `}to your home? You will verify a code at your Home. It will open your home and be told about changes; it never signs for you.`, summary: { ceremony: 'channel-link', kind, value } });
      const channels = (await readChannels(deps, me)) ?? [];
      const live = channels.filter((c) => !c.unlinkedAt && c.kind === kind);
      const hit = value ? matchChannel(channels, kind, value)[0] : live.sort((a, b) => b.linkedAt.localeCompare(a.linkedAt))[0];
      return hit ? { linked: true, kind, channel: maskChannel(hit), answer: `${kind === 'email' ? 'Email' : 'Phone'} ${maskChannel(hit)} now opens your home and is told about changes.` } : { refused: `the ${kind} was not linked — nothing changed; the code may not have been verified` };
    }

    if (toolId === CHANNEL_UNLINK_CAPABILITY) {
      const kind = String(args.kind ?? '').toLowerCase();
      if (kind !== 'email' && kind !== 'phone') return { refused: 'an email or a phone? name which to unlink' };
      const channels = (await readChannels(deps, me)) ?? [];
      const hits = matchChannel(channels, kind, String(args.channel ?? ''));
      if (hits.length !== 1) return { refused: hits.length === 0 ? `no ${kind} is linked that matches` : `${hits.length} ${kind}s are linked (${hits.map(maskChannel).join(', ')}) — say which` };
      const target = hits[0]!;
      if (!confirmed) throw new InputRequired({ kind: 'confirmation', stepRef, toolId, prompt: `Unlink ${kind} ${maskChannel(target)}? It stops opening your home and stops being told about changes. Nothing on chain changes.`, summary: { ceremony: 'channel-unlink', kind, value: target.value } });
      const after = (await readChannels(deps, me)) ?? [];
      const still = after.find((c) => c.kind === kind && c.value.toLowerCase() === target.value.toLowerCase() && !c.unlinkedAt);
      return still ? { refused: `the ${kind} is still linked — nothing changed` } : { unlinked: true, kind, channel: maskChannel(target), answer: `${kind === 'email' ? 'Email' : 'Phone'} ${maskChannel(target)} no longer opens your home.` };
    }

    return { refused: `unknown security act ${toolId}` };
  };
}

// ── The chain half of the deps: view calls only, never a log scan (ADR-0012) ───────────────────────────────────────
const ACCOUNT_ABI = [
  { type: 'function', name: 'custodianCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'passkeyCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'hasPasskey', stateMutability: 'view', inputs: [{ name: 'credentialIdDigest', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;
const CUSTODY_MODE_ABI = [{ type: 'function', name: 'custodyMode', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint8' }] }] as const;

export function securityChainDeps(env: { RPC_URL?: string; CUSTODY_POLICY?: string }): Pick<SecurityDeps, 'readCounts' | 'readPresence' | 'readCustodyMode'> {
  const pub = () => { if (!env.RPC_URL) throw new Error('RPC_URL is not configured'); return createPublicClient({ transport: http(env.RPC_URL) }); };
  return {
    readCounts: async (person) => {
      const [c, p] = await Promise.all([
        pub().readContract({ address: person, abi: ACCOUNT_ABI, functionName: 'custodianCount' }),
        pub().readContract({ address: person, abi: ACCOUNT_ABI, functionName: 'passkeyCount' }),
      ]);
      return { custodians: Number(c), passkeys: Number(p) };
    },
    readPresence: async (person, ref) => ref.kind === 'passkey'
      ? pub().readContract({ address: person, abi: ACCOUNT_ABI, functionName: 'hasPasskey', args: [ref.credentialIdDigest] })
      : pub().readContract({ address: person, abi: ACCOUNT_ABI, functionName: 'isCustodian', args: [ref.address] }),
    readCustodyMode: async (person) => {
      const cp = env.CUSTODY_POLICY;
      if (!cp || !/^0x[0-9a-fA-F]{40}$/.test(cp)) return 0; // no policy on this estate ⇒ every account is self-governed
      return Number(await pub().readContract({ address: cp as Address, abi: CUSTODY_MODE_ABI, functionName: 'custodyMode', args: [person] }));
    },
  };
}
