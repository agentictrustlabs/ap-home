'use client';
// WHAT MY AGENT DID — spec 381 W3. One run's provenance read back from the vault as spans and drawn as a
// timeline: the run, then each step under it with what it was, how long it took, how it ended, under whose
// authority, and the hand-offs it links to. The same bytes an OTLP exporter would carry, offered as a
// download so the person can take them elsewhere. Read on demand; nothing is fetched for a run nobody opens.
import { useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { fetchSpans, fetchProvenance, type SpanRow, fetchPublicProvenance, type AnchoredOutcome, type RunAnchor, type RunAnchorCitation } from '../../../home/ask';

const ATTR = {
  step: 'ap.step.ref', status: 'ap.step.status', capability: 'ap.capability.id', risk: 'ap.risk',
  decision: 'ap.authority.verdict', presented: 'ap.authority.mandate.ref', chain: 'ap.authority.chain.depth',
  outcome: 'ap.run.outcome', origin: 'ap.trace.origin', error: 'ap.error.class', link: 'ap.link.kind',
  // Spec 390 W3 — the stage spans: which model planned or composed, and why the route put it there.
  model: 'gen_ai.request.model', provider: 'gen_ai.provider.name', route: 'ap.route.because', standing: 'ap.standing.relation', tx: 'ap.action.tx_hash',
} as const;
const short = (v: unknown, n = 14): string => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 4)}…${t.slice(-3)}` : t; };
const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(ms))}ms`);

function attr(sp: SpanRow, key: string): string | undefined { const v = sp.attributes[key]; return v === undefined ? undefined : String(v); }

/** The run's spans as a tree: roots first, children under their parent, in start order. */
function ordered(spans: SpanRow[]): Array<{ span: SpanRow; depth: number }> {
  const byParent = new Map<string | undefined, SpanRow[]>();
  for (const sp of spans) { const k = sp.parentSpanId && spans.some((x) => x.spanId === sp.parentSpanId) ? sp.parentSpanId : undefined; byParent.set(k, [...(byParent.get(k) ?? []), sp]); }
  const out: Array<{ span: SpanRow; depth: number }> = [];
  const walk = (parent: string | undefined, depth: number) => { for (const sp of (byParent.get(parent) ?? []).sort((a, b) => a.startMs - b.startMs)) { out.push({ span: sp, depth }); walk(sp.spanId, depth + 1); } };
  walk(undefined, 0);
  return out;
}

export function RunTimeline({ token, addressee, runRef, open }: { token: string; addressee: Address; runRef: string; open?: boolean }) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; spans: SpanRow[]; error?: string; exporter?: string }>({ status: 'idle', spans: [] });
  // Spec 395 — what of this run ANYONE can verify: its anchored outcomes, read from the public route (no session).
  const [anchored, setAnchored] = useState<AnchoredOutcome[] | null>(null);
  const [runAnchor, setRunAnchor] = useState<RunAnchor | null>(null);
  // Spec 410 §4.4 — an act performed in ANOTHER estate: the vault's citation says which chain anchored it.
  const [elsewhere, setElsewhere] = useState<{ citation: RunAnchorCitation; note?: string } | null>(null);
  const load = async () => {
    setState((s) => ({ ...s, status: 'loading' }));
    const out = await fetchSpans({ token }, addressee, runRef);
    if ('error' in out) setState({ status: 'error', spans: [], error: out.error });
    else setState({ status: 'ready', spans: out.spans, ...(out.exporter ? { exporter: out.exporter } : {}) });
    const pub = await fetchPublicProvenance(addressee, runRef);
    setAnchored('error' in pub ? [] : pub.rows);
    setRunAnchor('error' in pub ? null : pub.anchor ?? null);
    setElsewhere(!('error' in pub) && pub.citation && !pub.anchor ? { citation: pub.citation, ...(pub.note ? { note: pub.note } : {}) } : null);
  };
  if (open && state.status === 'idle') void load();
  const save = (text: string, name: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const download = () => save(JSON.stringify({ runRef, spans: state.spans }, null, 2), `${runRef}.spans.json`, 'application/json');
  // Spec 389 W3 — the run's PROV graph, as the vault holds it (JSON-LD) or as PROV-N: read on click, never fetched
  // for a run nobody asks about. A stock PROV tool loads either.
  const downloadProvenance = async (format: 'jsonld' | 'prov-n') => {
    const out = await fetchProvenance({ token }, addressee, runRef, format);
    if ('error' in out) { setState((s) => ({ ...s, error: out.error })); return; }
    save(out.text, format === 'jsonld' ? `${runRef}.provenance.jsonld` : `${runRef}.provenance.provn`, format === 'jsonld' ? 'application/ld+json' : 'text/provenance-notation');
  };
  const t0 = state.spans.length ? Math.min(...state.spans.map((s) => s.startMs)) : 0;
  return (
    <div className="muted" style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.55 }} data-testid="run-timeline">
      {state.status === 'idle' && <button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} onClick={() => void load()}>what my agent did (spans)</button>}
      {state.status === 'loading' && <span>reading the run back…</span>}
      {state.status === 'error' && <span style={{ color: 'var(--c-danger, #dc2626)' }}>{state.error}</span>}
      {state.status === 'ready' && (
        <>
          <div>
            <strong>provenance</strong> {state.spans.length} span{state.spans.length === 1 ? '' : 's'}{state.exporter && state.exporter !== 'none' ? ` · exported via ${state.exporter}` : ''}
            {' '}<button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} onClick={download}>download spans</button>
            {' '}<button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} onClick={() => void downloadProvenance('jsonld')}>PROV (JSON-LD)</button>
            {' '}<button type="button" className="btn ghost" style={{ fontSize: 10.5, padding: '0 6px', minHeight: 0 }} onClick={() => void downloadProvenance('prov-n')}>PROV-N</button>
          </div>
          {runAnchor && (
            <div data-testid="run-anchor" title="The run's PROV bundle, hashed canonically (stable-key JSON, keccak256), is anchored in the ReceiptAnchorRegistry by the runtime's harness agent — bound to the intent digest. Anyone holding the bundle recomputes and reads anchorOf(digest) on the chain.">
              <strong>anchored on chain</strong> bundle {runAnchor.digest.slice(0, 14)}… · by {runAnchor.anchoredBy.slice(0, 10)}…{runAnchor.txHash ? ` · tx ${runAnchor.txHash.slice(0, 12)}…` : ''}{runAnchor.chainId ? ` · chain ${runAnchor.chainId}` : ''}
            </div>
          )}
          {elsewhere && (
            <div data-testid="run-anchor-elsewhere" title={elsewhere.note ?? 'This act was performed in another estate; its receipt is anchored on that estate\'s chain. Verify there with the digest and the anchorer the citation names.'}>
              <strong>anchored in another estate</strong>{elsewhere.citation.registry ? ` · ${elsewhere.citation.registry.startsWith('eip155:') ? `chain ${elsewhere.citation.registry.split(':')[1]}` : elsewhere.citation.registry}` : ''}{elsewhere.citation.estate ? ` · estate ${elsewhere.citation.estate.slice(0, 12)}…` : ''}{elsewhere.citation.digest ? ` · bundle ${elsewhere.citation.digest.slice(0, 14)}…` : ''}{elsewhere.citation.anchoredBy ? ` · by ${elsewhere.citation.anchoredBy.slice(0, 10)}…` : ''} — this Home reads its own estate's chain; verify at that one
            </div>
          )}
          {anchored && anchored.length > 0 && (
            <div data-testid="run-public-provenance" title="Anyone holding a receipt of this run can verify it against the agent's public projection — digests and the transaction, nothing the run was about.">
              <strong>publicly verifiable</strong> {anchored.length} anchored outcome{anchored.length === 1 ? '' : 's'}
              {anchored.map((a) => <span key={a['@id']}> · {a.capability ?? 'step'} → tx {a.anchoredBy.slice(0, 10)}…</span>)}
            </div>
          )}
          {ordered(state.spans).map(({ span: sp, depth }) => {
            const step = attr(sp, ATTR.step); const status = attr(sp, ATTR.status); const cap = attr(sp, ATTR.capability); const risk = attr(sp, ATTR.risk);
            const decision = attr(sp, ATTR.decision); const presented = attr(sp, ATTR.presented); const outcome = attr(sp, ATTR.outcome); const origin = attr(sp, ATTR.origin); const err = attr(sp, ATTR.error);
            const provider = attr(sp, ATTR.provider); const route = attr(sp, ATTR.route); const standing = attr(sp, ATTR.standing); const tx = attr(sp, ATTR.tx);
            const bad = sp.status === 'ERROR' || status === 'refused' || status === 'failed';
            return (
              <div key={sp.spanId} style={{ display: 'flex', gap: 8, paddingLeft: depth * 14, alignItems: 'baseline' }}>
                <span style={{ flex: 'none', width: 46, textAlign: 'right', opacity: 0.6 }}>+{fmtMs(sp.startMs - t0)}</span>
                <span aria-hidden style={{ flex: 'none', color: bad ? 'var(--c-danger, #dc2626)' : 'var(--c-success, #047857)' }}>{bad ? '✗' : '✓'}</span>
                <span style={{ flex: 1 }}>
                  <strong>{sp.name}</strong>{step ? ` ${step}` : ''} · {fmtMs(sp.endMs - sp.startMs)}
                  {cap ? ` · ${cap}` : ''}{risk ? ` (${risk})` : ''}
                  {status ? ` · ${status}` : outcome ? ` · ${outcome}` : ''}
                  {decision ? ` · authority ${decision}${presented ? ` under ${short(presented)}` : ''}` : ''}
                  {provider ? ` · ${provider}` : ''}{route ? ` · ${route}` : ''}{standing ? ` · standing ${standing}` : ''}{tx ? ` · tx ${short(tx)}` : ''}
                  {origin ? ` · for run ${short(origin, 18)}` : ''}
                  {err ? ` · ${err}` : ''}
                  {sp.links?.length ? ` · ${sp.links.map((l) => `${String(l.attributes?.[ATTR.link] ?? 'linked')} ${short(l.spanId)}`).join(', ')}` : ''}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
