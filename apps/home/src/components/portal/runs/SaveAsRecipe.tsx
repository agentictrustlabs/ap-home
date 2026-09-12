'use client';
// SAVE AS RECIPE — spec 398 §5 / APUX-034 (G3). On a COMPLETED run only: the runtime drafts a SKILL.md from the record
// and the playbook (steps, capabilities, parties as roles; no key can reach it — the keyring is not an input), the
// person reads what it holds, and SAVES it into the workspace's Library under recipes/. The saved file says, in its own
// words, that assigning it grants nothing. Two steps, each said: draft (a read) → save (the person's act).
import { useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { draftRecipeOf, type RecipeDraft } from '../../../home/ask';
import { recipeSaveTarget, recipeSummary } from '../../../home/recipe';
import { BusyButton } from '../../shared/BusyButton';
import type { WorkspaceScope } from '../../../lib/workspace';

export function SaveAsRecipe({ token, addressee, runRef, scope }: { token: string; addressee: Address; runRef: string; scope: WorkspaceScope }) {
  const [draft, setDraft] = useState<RecipeDraft | null>(null);
  const [busy, setBusy] = useState<'draft' | 'save' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ href: string; name: string } | null>(null);

  const doDraft = async () => {
    setBusy('draft'); setErr(null);
    const out = await draftRecipeOf({ token }, addressee, runRef);
    setBusy(null);
    if (!out.ok) { setErr(out.error); return; }
    setDraft(out.recipe);
  };
  const doSave = async () => {
    if (!draft) return;
    setBusy('save'); setErr(null);
    const target = recipeSaveTarget(draft, scope);
    try {
      const r = await fetch(`/connect/library${target.scopeQuery}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', ...(target.scopeQuery ? { org: target.scopeQuery.slice('?org='.length) } : {}), artifact: target.artifact }) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; artifact?: { id: string; name: string } };
      if (!r.ok || !b.ok) throw new Error(b.error ?? `the Library answered ${r.status}`);
      setSaved({ href: `${target.libraryHref}&open=${encodeURIComponent(b.artifact?.id ?? '')}`, name: b.artifact?.name ?? target.artifact.name });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  if (saved) return <div data-testid="recipe-saved">saved to the Library as <a href={saved.href}><code>{saved.name}</code></a> — a draft; assigning it asks for authority anew</div>;
  return (
    <div data-testid="save-as-recipe" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {!draft && <BusyButton busy={busy === 'draft'} busyLabel="Drafting…" className="btn-ghost" style={{ width: 'auto', fontSize: '0.72rem' }} onClick={() => void doDraft()} title="A draft SKILL.md from this run's plan: steps, capabilities, parties as roles. No key, no mandate can reach it." data-testid="recipe-draft">Save as recipe…</BusyButton>}
        {draft && <>
          <span><code>{draft.fileName}</code> · {recipeSummary(draft)}</span>
          <BusyButton busy={busy === 'save'} busyLabel="Saving…" className="btn-primary" style={{ width: 'auto', fontSize: '0.72rem' }} onClick={() => void doSave()} data-testid="recipe-save">Save to the Library</BusyButton>
          <button type="button" className="btn-ghost" style={{ fontSize: '0.72rem' }} onClick={() => setDraft(null)}>Discard</button>
        </>}
      </div>
      {draft && draft.notes.length > 0 && <div style={{ opacity: 0.7 }}>not carried: {draft.notes.join(' · ')}</div>}
      {draft && <details><summary style={{ cursor: 'pointer' }}>the draft</summary><pre style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', margin: '0.25rem 0' }} data-testid="recipe-text">{draft.skillMd}</pre></details>}
      {err && <div style={{ color: 'var(--color-danger)' }}>{err}</div>}
    </div>
  );
}
