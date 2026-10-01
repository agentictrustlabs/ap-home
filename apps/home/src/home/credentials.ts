// THE CREDENTIAL SET — spec 422 §3.1. "Who can sign for you", as a list and never a count.
//
// The CHAIN is the set: `hasPasskey(digest)` / `isCustodian(address)` decide what signs for the person. The VAULT
// holds the labels (`security.credentials`: device name, created, kind, retired) and the channels that open the
// home (`security.channels`: emails and phones — never signers). This module joins the two the only honest way:
// every labelled entry is CONFIRMED against the chain row by row; a label the chain denies renders as retired;
// a chain count the labels do not reach renders as "N unlabelled". The record never decides what signs.
//
// Grades are facts of the chain (ADR-0017): custody-grade = in the custodian set (a passkey, a wallet, the
// server-held C_sub behind a Google / email / phone home); login-grade = opens the home, signs nothing.
import { createPublicClient, http } from 'viem';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN } from '../lib/chain';
import { loadPasskey } from '../lib/passkey';
import { cachedConnectionCustodian, readCredentialCounts, readCustodyMode } from '../connect-client';
import { readPersonRecord, writePersonRecord } from '../profile-store';

export type CredentialGrade = 'custody-grade' | 'login-grade';
/** Spec 221 §4 lifecycle states a label can carry. `active` is the chain's word, confirmed on every read. */
export type CredentialState = 'active' | 'pending-active' | 'retired' | 'superseded' | 'revoked' | 'compromised';
export type CredentialRef =
  | { kind: 'passkey'; credentialIdDigest: Hex }
  | { kind: 'custodian'; address: Address };

/** One labelled credential in the person's vault. */
export interface CredentialLabelV1 {
  ref: CredentialRef;
  label: string;
  /** Where the credential lives, in her words ("Rich's laptop", "MetaMask"). */
  device?: string;
  /** For a server-held key: the method it stands for (the chain only sees an address). */
  method?: 'google' | 'email' | 'phone' | 'youversion';
  createdAt: string;
  state?: CredentialState;
  retiredAt?: string;
}
export interface SecurityCredentialsRecordV1 { v: 1; items: CredentialLabelV1[] }

export interface ChannelV1 {
  kind: 'email' | 'phone';
  value: string;
  linkedAt: string;
  unlinkedAt?: string;
}
export interface SecurityChannelsRecordV1 { v: 1; items: ChannelV1[] }

/** A row on the Sign-in page. */
export interface CredentialRow {
  key: string;
  grade: CredentialGrade;
  kind: 'passkey' | 'wallet' | 'server-key' | 'email' | 'phone';
  label: string;
  /** The second line: the device, the method, or the masked channel. */
  sub: string;
  thisDevice: boolean;
  state: CredentialState;
  /** The chain confirmed this row on this read (custody rows only). */
  onChain: boolean;
  ref?: CredentialRef;
  channel?: ChannelV1;
  createdAt?: string;
}

export interface CredentialSet {
  rows: CredentialRow[];
  /** Chain entries no label reaches. Said as a number because the chain gives no more than a count for them. */
  unlabelled: { passkeys: number; custodians: number };
  counts: { passkeys: number; custodians: number };
  /** 0 = self-governed (every Home person today); 1–3 = custody-governed (spec 207 §4). */
  custodyMode: number;
  /** The reads that failed, by name (398 §6.3 — never rendered as zero). */
  unknown: string[];
}

const PRESENCE_ABI = [
  { type: 'function', name: 'hasPasskey', stateMutability: 'view', inputs: [{ name: 'credentialIdDigest', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;

export const CREDENTIALS_RECORD = 'security.credentials' as const;
export const CHANNELS_RECORD = 'security.channels' as const;

export const refKey = (r: CredentialRef): string =>
  r.kind === 'passkey' ? `passkey:${r.credentialIdDigest.toLowerCase()}` : `custodian:${r.address.toLowerCase()}`;

/** Is this credential in the account's set right now? A view call through the runtime's RPC proxy (ADR-0012). */
export async function readCredentialPresence(person: Address, ref: CredentialRef, rpcUrl = '/a2a/rpc'): Promise<boolean> {
  const pub = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
  if (ref.kind === 'passkey') return pub.readContract({ address: person, abi: PRESENCE_ABI, functionName: 'hasPasskey', args: [ref.credentialIdDigest] });
  return pub.readContract({ address: person, abi: PRESENCE_ABI, functionName: 'isCustodian', args: [ref.address] });
}

export function maskChannel(c: ChannelV1): string {
  if (c.kind === 'email') {
    const [u, d] = c.value.split('@');
    return u && d ? `${u.slice(0, 2)}…@${d}` : c.value;
  }
  const digits = c.value.replace(/\D/g, '');
  return digits.length >= 4 ? `…${digits.slice(-4)}` : c.value;
}

const METHOD_WORDS: Record<NonNullable<CredentialLabelV1['method']>, string> = {
  google: 'Google', email: 'Email', phone: 'Phone (SMS)', youversion: 'YouVersion',
};

/**
 * The join (spec 422 §3.1): labels ⊕ chain ⊕ this device ⊕ channels → rows. PURE over its inputs so a test can
 * pin every branch; `readCredentialSet` gathers the inputs.
 */
export function joinCredentialSet(input: {
  labels: CredentialLabelV1[];
  present: Map<string, boolean>;
  counts: { passkeys: number; custodians: number };
  thisDevice: { credentialIdDigest: Hex; label: string } | null;
  channels: ChannelV1[];
  custodyMode: number;
  unknown?: string[];
}): CredentialSet {
  const rows: CredentialRow[] = [];
  let labelledPasskeys = 0;
  let labelledCustodians = 0;
  for (const l of input.labels) {
    const key = refKey(l.ref);
    const onChain = input.present.get(key) === true;
    const retired: CredentialState | null = l.state && l.state !== 'active' && l.state !== 'pending-active' ? l.state : null;
    // The chain decides: a label the chain denies is retired, whatever the label says; a retired label the chain
    // still holds is ACTIVE — the retirement did not happen, and saying otherwise would hide a live key.
    const state: CredentialState = onChain ? 'active' : (retired ?? (l.state === 'pending-active' ? 'pending-active' : 'retired'));
    if (onChain) { if (l.ref.kind === 'passkey') labelledPasskeys += 1; else labelledCustodians += 1; }
    const thisDevice = l.ref.kind === 'passkey' && !!input.thisDevice && l.ref.credentialIdDigest.toLowerCase() === input.thisDevice.credentialIdDigest.toLowerCase();
    const kind: CredentialRow['kind'] = l.ref.kind === 'passkey' ? 'passkey' : l.method ? 'server-key' : 'wallet';
    const sub = kind === 'passkey'
      ? (thisDevice ? 'This device' : (l.device ?? 'Another device'))
      : kind === 'server-key'
        ? `Server-secured key for your ${METHOD_WORDS[l.method!]} sign-in`
        : (l.device ?? `Wallet ${l.ref.kind === 'custodian' ? `${l.ref.address.slice(0, 6)}…${l.ref.address.slice(-4)}` : ''}`);
    rows.push({ key, grade: 'custody-grade', kind, label: l.label, sub, thisDevice, state, onChain, ref: l.ref, createdAt: l.createdAt });
  }
  // This device's passkey with no label yet: the chain has it (a count), the vault does not (no row) — show it, named
  // for what it is, so the person can label it; `labelThisDevice` writes the label on first view.
  if (input.thisDevice && !input.labels.some((l) => l.ref.kind === 'passkey' && l.ref.credentialIdDigest.toLowerCase() === input.thisDevice!.credentialIdDigest.toLowerCase())) {
    const key = refKey({ kind: 'passkey', credentialIdDigest: input.thisDevice.credentialIdDigest });
    const onChain = input.present.get(key) === true;
    if (onChain) labelledPasskeys += 1;
    rows.push({ key, grade: 'custody-grade', kind: 'passkey', label: input.thisDevice.label || 'Passkey', sub: 'This device', thisDevice: true, state: onChain ? 'active' : 'retired', onChain, ref: { kind: 'passkey', credentialIdDigest: input.thisDevice.credentialIdDigest } });
  }
  for (const c of input.channels) {
    if (c.unlinkedAt) continue;
    rows.push({ key: `${c.kind}:${c.value.toLowerCase()}`, grade: 'login-grade', kind: c.kind, label: c.kind === 'email' ? 'Email' : 'Phone (SMS)', sub: maskChannel(c), thisDevice: false, state: 'active', onChain: false, channel: c, createdAt: c.linkedAt });
  }
  // Active custody first, this device first among them; then channels; retired last.
  const order = (r: CredentialRow): number => (r.state === 'active' ? (r.grade === 'custody-grade' ? (r.thisDevice ? 0 : 1) : 2) : 3);
  rows.sort((a, b) => order(a) - order(b));
  return {
    rows,
    unlabelled: { passkeys: Math.max(0, input.counts.passkeys - labelledPasskeys), custodians: Math.max(0, input.counts.custodians - labelledCustodians) },
    counts: input.counts,
    custodyMode: input.custodyMode,
    unknown: input.unknown ?? [],
  };
}

async function readLabels(person: Address): Promise<CredentialLabelV1[]> {
  const rec = (await readPersonRecord(person, CREDENTIALS_RECORD)) as SecurityCredentialsRecordV1 | null;
  return rec && rec.v === 1 && Array.isArray(rec.items) ? rec.items : [];
}
async function readChannels(person: Address): Promise<ChannelV1[]> {
  const rec = (await readPersonRecord(person, CHANNELS_RECORD)) as SecurityChannelsRecordV1 | null;
  return rec && rec.v === 1 && Array.isArray(rec.items) ? rec.items : [];
}

/**
 * Gather and join. Reads that fail are NAMED in `unknown` and the rest still renders (398 §6.3) — except the chain
 * counts, which are the set itself: without them the page says Unknown and nothing else.
 */
export async function readCredentialSet(person: Address, opts: {
  /** The signed-in session's credential kind (`/me/profile` `credential`) and sign-in word, to name the C_sub row. */
  sessionCredential?: string; via?: string;
} = {}): Promise<CredentialSet> {
  const unknown: string[] = [];
  const [counts, custodyMode] = await Promise.all([readCredentialCounts(person), readCustodyMode(person).catch(() => { unknown.push('custody mode'); return 0; })]);
  let labels: CredentialLabelV1[] = [];
  let channels: ChannelV1[] = [];
  try { labels = await readLabels(person); } catch { unknown.push('credential labels (your vault)'); }
  try { channels = await readChannels(person); } catch { unknown.push('contact channels (your vault)'); }
  // A social home's server-held key: the chain shows one custodian; the Home knows which method it stands for.
  const cSub = cachedConnectionCustodian(person);
  const via = (opts.via ?? '').toLowerCase();
  const method = (['google', 'email', 'phone', 'youversion'] as const).find((m) => m === via);
  if (cSub && method && !labels.some((l) => l.ref.kind === 'custodian' && l.ref.address.toLowerCase() === cSub.toLowerCase())) {
    labels = [...labels, { ref: { kind: 'custodian', address: cSub }, label: `${METHOD_WORDS[method]} sign-in`, method, createdAt: '' }];
  }
  const present = new Map<string, boolean>();
  const pk = loadPasskey();
  const refs: CredentialRef[] = labels.map((l) => l.ref);
  if (pk && !refs.some((r) => r.kind === 'passkey' && r.credentialIdDigest.toLowerCase() === pk.credentialIdDigest.toLowerCase())) refs.push({ kind: 'passkey', credentialIdDigest: pk.credentialIdDigest });
  await Promise.all(refs.map(async (r) => {
    try { present.set(refKey(r), await readCredentialPresence(person, r)); }
    catch { unknown.push(`chain presence of ${r.kind === 'passkey' ? 'a passkey' : 'a custodian'}`); }
  }));
  return joinCredentialSet({ labels, present, counts, thisDevice: pk ? { credentialIdDigest: pk.credentialIdDigest, label: pk.label } : null, channels, custodyMode, unknown });
}

/** Upsert one label (by ref) in the person's vault. */
export async function writeCredentialLabel(person: Address, item: CredentialLabelV1): Promise<void> {
  let items: CredentialLabelV1[] = [];
  try { items = await readLabels(person); } catch { /* first write */ }
  const k = refKey(item.ref);
  const next = items.filter((l) => refKey(l.ref) !== k);
  next.push({ ...(items.find((l) => refKey(l.ref) === k) ?? {}), ...item });
  await writePersonRecord(person, CREDENTIALS_RECORD, { v: 1, items: next } satisfies SecurityCredentialsRecordV1);
}

/** Mark a label retired (the chain already said so, or a ceremony just did). Keeps the row for the history. */
export async function retireCredentialLabel(person: Address, ref: CredentialRef, state: Exclude<CredentialState, 'active' | 'pending-active'> = 'retired'): Promise<void> {
  const items = await readLabels(person).catch(() => [] as CredentialLabelV1[]);
  const k = refKey(ref);
  const hit = items.find((l) => refKey(l.ref) === k);
  if (!hit) return;
  await writeCredentialLabel(person, { ...hit, state, retiredAt: new Date().toISOString() });
}

/** Record a channel that now opens this home (after the server linked the facet). */
export async function recordChannel(person: Address, c: Omit<ChannelV1, 'linkedAt'>): Promise<void> {
  const items = await readChannels(person).catch(() => [] as ChannelV1[]);
  const next = items.filter((x) => !(x.kind === c.kind && x.value.toLowerCase() === c.value.toLowerCase()));
  next.push({ ...c, linkedAt: new Date().toISOString() });
  await writePersonRecord(person, CHANNELS_RECORD, { v: 1, items: next } satisfies SecurityChannelsRecordV1);
}

/** Mark a channel unlinked (after the server tombstoned the facet). */
export async function forgetChannel(person: Address, c: Pick<ChannelV1, 'kind' | 'value'>): Promise<void> {
  const items = await readChannels(person).catch(() => [] as ChannelV1[]);
  const next = items.map((x) => (x.kind === c.kind && x.value.toLowerCase() === c.value.toLowerCase() ? { ...x, unlinkedAt: new Date().toISOString() } : x));
  await writePersonRecord(person, CHANNELS_RECORD, { v: 1, items: next } satisfies SecurityChannelsRecordV1);
}
