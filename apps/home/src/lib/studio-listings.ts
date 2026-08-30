// Stage ③ "List it" (flow-redesign.md §5): projections become LISTINGS — places the agent appears — each a
// row with a product name, a one-sentence purpose, a status and ONE button. Names come from the white-label
// config, never from spec numbers. Pure; the page renders what this returns.
import type { StoredProjection, StudioFamily } from '../studio-client';
import { gateForOp, gateForPublish } from './studio-view';

export interface ListingDescriptor {
  family: StudioFamily;
  title: string;
  purpose: string;
  /** What `[Open]` opens: a sentence for the title attribute. */
  opens: string;
}

/** `name` is the agent's typed name (for the purpose sentence); `brand` the deployment's product name. */
export function listingCatalog(input: { brand: string; agentName: string }): Record<StudioFamily, ListingDescriptor> {
  const name = input.agentName || 'this agent';
  return {
    'ap-naming': {
      family: 'ap-naming',
      title: 'Your name record',
      purpose: `Point ${name} at this card, so anyone who looks the name up finds it.`,
      opens: 'the public record for this name',
    },
    'ap-registry': {
      family: 'ap-registry',
      title: `${input.brand} directory`,
      purpose: 'Appear in the directory agents and people search.',
      opens: 'this agent\'s entry in the directory',
    },
  };
}

export type ListingState = 'needs-card' | 'not-listed' | 'listed' | 'out-of-date' | 'missing-role';

export interface ListingRow {
  family: StudioFamily;
  title: string;
  purpose: string;
  state: ListingState;
  /** The status line, plain. */
  line: string;
  button: { id: 'list' | 'update' | 'open'; label: string } | null;
  /** Always available once listed: things change outside the card (an agent moves host, a record is edited by
   *  hand), and "Listed ✓" only knows that the CARD VERSION matches — not that the record still says the right
   *  thing. Without this, a stale record has no way back. */
  secondary?: { id: 'update'; label: string };
  /** One sentence above the button when something will not carry over; null when nothing is lost. */
  loss: string | null;
  projection: StoredProjection | null;
}

/** What the busy button says while a listing is being written (one custodian prompt, explained). */
export const LISTING_PHRASE = {
  preparing: 'Preparing…',
  custodian: 'Your custodian signs once to write the record',
  writing: 'Writing to the chain…',
  confirming: 'Confirming…',
} as const;

export function listingRow(input: {
  descriptor: ListingDescriptor;
  projection: StoredProjection | null;
  /** The live, published release — `null` until step ② is done. */
  published: { releaseId: string; signedContentDigest?: string } | null;
  scopes: readonly string[];
  losses?: readonly { category: string; severity: string; sourcePointer?: string }[];
  /** May this person's signer act for the agent's account on chain? `false` = definitely not (a steward who is
   *  not a custodian); `null` = unknowable from here, let the chain decide. */
  custodian?: boolean | null;
}): ListingRow {
  const d = input.descriptor;
  const base = { family: d.family, title: d.title, purpose: d.purpose, projection: input.projection, loss: lossSentence(d.title, input.losses ?? []) };
  if (!input.published) return { ...base, state: 'needs-card', line: 'Publish the card first (step ②).', button: null, loss: null };
  const canList = gateForOp(input.scopes, 'projection.preview').allowed && gateForOp(input.scopes, 'projection.approve').allowed && gateForPublish(input.scopes, d.family).allowed;
  const p = input.projection;
  const listed = !!p?.instance.lastPublication;
  const NEEDS_CUSTODIAN = "Needs this agent's custodian to sign — you steward it but don't hold its keys. Ask whoever custodies it (Access shows who) to list it.";
  if (!listed) {
    if (!canList) return { ...base, state: 'missing-role', line: `Needs someone with listing rights for ${d.title.toLowerCase()}.`, button: null };
    if (input.custodian === false) return { ...base, state: 'missing-role', line: NEEDS_CUSTODIAN, button: null };
    return { ...base, state: 'not-listed', line: 'Not listed', button: { id: 'list', label: 'List it' } };
  }
  const current = p!.selectedCard?.releaseId === input.published.releaseId && !['drifted', 'stale', 'failed'].includes(p!.instance.state);
  const when = new Date(p!.instance.lastPublication!.publishedAt).toLocaleString();
  if (current) {
    return {
      ...base,
      state: 'listed',
      line: `Listed ✓ · updated ${when}`,
      button: { id: 'open', label: 'Open' },
      ...(input.custodian === false ? {} : { secondary: { id: 'update' as const, label: 'Write it again' } }),
      loss: null,
    };
  }
  if (!canList) return { ...base, state: 'missing-role', line: `Listed, but shows an older version of the card. Needs someone with listing rights to update it.`, button: null };
  if (input.custodian === false) return { ...base, state: 'missing-role', line: `Listed, but shows an older version of the card. ${NEEDS_CUSTODIAN}`, button: null };
  return { ...base, state: 'out-of-date', line: 'Listed, but shows an older version of the card.', button: { id: 'update', label: 'Update listing' } };
}

/** "The directory can't show 2 of your 5 skills — it will list the other 3." Never a count of losses as the headline. */
export function lossSentence(title: string, losses: readonly { category: string; severity: string; sourcePointer?: string }[], skillCount?: number): string | null {
  const real = losses.filter((l) => l.severity !== 'info' && l.category !== 'manualActionRequired');
  if (real.length === 0) return null;
  const skills = real.filter((l) => (l.sourcePointer ?? '').includes('/skill'));
  if (skills.length && skillCount) {
    const kept = Math.max(0, skillCount - skills.length);
    return `${title} can't show ${skills.length} of your ${skillCount} skill${skillCount === 1 ? '' : 's'} — it will list the other ${kept}.`;
  }
  return `${real.length} detail${real.length === 1 ? '' : 's'} won't carry over to ${title.toLowerCase()} — see Details.`;
}

/** Every string stage ③ can show on its main path (flow-redesign §9.4). */
export function listingCopySamples(): string[] {
  const cat = listingCatalog({ brand: 'Faithnet', agentName: 'alice.me' });
  const out: string[] = [];
  for (const d of Object.values(cat)) {
    out.push(d.title, d.purpose, d.opens);
    for (const published of [null, { releaseId: 'r1' }]) {
      for (const scopes of [[], ['agent.projection.preview', 'agent.projection.approve', 'agent.projection.publish:ap-naming', 'agent.projection.publish:ap-registry']]) {
        const row = listingRow({ descriptor: d, projection: null, published, scopes, losses: [{ category: 'truncated', severity: 'warning', sourcePointer: '/skills/3' }] });
        out.push(row.line, row.button?.label ?? '', row.loss ?? '');
      }
    }
  }
  out.push(...Object.values(LISTING_PHRASE), lossSentence('Faithnet directory', [{ category: 'truncated', severity: 'warning', sourcePointer: '/skills/1' }], 5) ?? '');
  return out.filter(Boolean);
}

// ── the tab strip (flow-redesign.md, split of 2026-08-30) ────────────────────────────────────────────────
// Agent Card first and always — a listing cannot exist without it, and a tab that shows its own gate
// ("Publish the card first") is what makes these tabs ordered rather than the peer tabs that confused before.

export interface StudioTab {
  id: string;
  label: string;
  /** Appended to `…/card/<id>` — '' for the Agent Card itself. */
  suffix: string;
  status: string;
  tone: 'good' | 'warn' | 'muted';
}

export function studioTabs(input: {
  brand: string;
  agentName: string;
  published: { releaseId: string } | null;
  cardStatus: { status: string; tone: 'good' | 'warn' | 'muted' };
  projections: readonly { family: StudioFamily; instance: { lastPublication?: unknown; state: string }; selectedCard: { releaseId: string } | null }[];
  scopes: readonly string[];
  custodian?: boolean | null;
}): StudioTab[] {
  const cat = listingCatalog({ brand: input.brand, agentName: input.agentName });
  const tabs: StudioTab[] = [{ id: 'card', label: 'Agent Card', suffix: '', status: input.cardStatus.status, tone: input.cardStatus.tone }];
  for (const family of ['ap-naming', 'ap-registry'] as StudioFamily[]) {
    const p = input.projections.find((x) => x.family === family) ?? null;
    const row = listingRow({ descriptor: cat[family], projection: p as never, published: input.published, scopes: input.scopes, custodian: input.custodian });
    tabs.push({
      id: family,
      label: cat[family].title,
      suffix: `/listing/${family}`,
      status: row.state === 'listed' ? 'Listed ✓' : row.state === 'out-of-date' ? 'Out of date' : row.state === 'needs-card' ? 'Card first' : row.state === 'missing-role' ? 'Needs someone else' : 'Not listed',
      tone: row.state === 'listed' ? 'good' : row.state === 'out-of-date' ? 'warn' : 'muted',
    });
  }
  tabs.push({ id: 'history', label: 'History', suffix: '/history', status: '', tone: 'muted' });
  return tabs;
}

// ── what the public record actually says ─────────────────────────────────────────────────────────────────
// A steward asked to see the listing and got our bookkeeping — state, target version, receipt id, artifact
// digest — instead of the record itself (2026-08-30). `binding.verify` already READS the live record from the
// chain; this turns what it read into rows a person can check against what they expected.

export interface RecordRow { label: string; value: string; hint?: string }

const NAMING_FIELDS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'addr', label: 'Points at', hint: 'The agent this name resolves to.' },
  { key: 'displayName', label: 'Shown as' },
  { key: 'agentKind', label: 'Kind' },
  { key: 'a2aEndpoint', label: 'Where it answers' },
  { key: 'cardUri', label: 'Card address' },
  { key: 'cardDigest', label: 'Card fingerprint', hint: 'Proves the card served there is the one that was published.' },
  { key: 'metadataUri', label: 'Profile' },
  { key: 'siteUrl', label: 'Website' },
  { key: 'description', label: 'Description' },
];

const ENTRY_STATUS: Record<number, string> = { 0: 'No entry', 1: 'Active', 2: 'Suspended', 3: 'Withdrawn' };

/** `observed` is what the chain returned — the naming records, or the registry entry. */
export function recordRows(family: StudioFamily, observed: unknown): RecordRow[] {
  if (!observed || typeof observed !== 'object') return [];
  const o = observed as Record<string, unknown>;
  if (family === 'ap-naming') {
    return NAMING_FIELDS.filter((f) => typeof o[f.key] === 'string' && o[f.key])
      .map((f) => ({ label: f.label, value: String(o[f.key]), ...(f.hint ? { hint: f.hint } : {}) }));
  }
  const rows: RecordRow[] = [];
  if (typeof o.subjectAgent === 'string') rows.push({ label: 'Entry for', value: o.subjectAgent, hint: 'The agent this entry describes.' });
  if (typeof o.status === 'number') rows.push({ label: 'Status', value: ENTRY_STATUS[o.status] ?? `Unknown (${o.status})` });
  if (typeof o.cardHash === 'string') rows.push({ label: 'Card fingerprint', value: o.cardHash, hint: 'Ties the entry to one exact published card.' });
  if (typeof o.bindingProofHash === 'string') rows.push({ label: 'Proof', value: o.bindingProofHash, hint: 'The agent signed this entry itself.' });
  if (typeof o.expiresAt === 'number' && o.expiresAt > 0) rows.push({ label: 'Expires', value: new Date(o.expiresAt * 1000).toLocaleString() });
  return rows;
}

/** One sentence on whether the live record still matches what was published. */
export function recordVerdictLine(ok: boolean, detail: string | null, title: string): string {
  if (ok) return `Checked just now — ${title.toLowerCase()} says exactly what was published.`;
  return `Checked just now — ${title.toLowerCase()} says something different from what was published${detail ? `: ${detail}` : ''}. Write it again to bring it back in line.`;
}
