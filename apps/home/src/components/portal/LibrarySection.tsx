'use client';
// The Content Artifact LIBRARY (spec 335) — view + manage documents as a person or an organization,
// and grant other agents access to a specific artifact. Backed by /connect/library; person scope by
// default, org scope when `orgSa` is set (steward-gated server-side). Artifacts are multi-source:
// a .ttl may come from GraphDB, a JSON-LD record from a vault — not just unstructured blobs.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty } from './theme';

type Kind = 'skill' | 'ttl' | 'md' | 'json-ld' | 'image';
type Source = 'blob' | 'graphdb' | 'vault' | 'external';
interface Grant { grantee: { address: string; kind: string; label?: string }; actions: string[]; grantedAt: number; revoked?: boolean }
interface Artifact { id: string; kind: Kind; name: string; source: Source; pointer?: string; contentType: string; size: number; createdAt: number; grants: Grant[] }

const KINDS: Kind[] = ['skill', 'ttl', 'md', 'json-ld', 'image'];
const SOURCES: Source[] = ['blob', 'graphdb', 'vault', 'external'];
const ACTIONS = ['read', 'write', 'share', 'export', 'delete'];

export function LibrarySection({ orgSa }: { orgSa?: string }) {
  const { session } = useSession();
  const token = session?.token ?? '';
  const scope = orgSa ? `?org=${orgSa}` : '';
  const [items, setItems] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // add-artifact form
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('md');
  const [source, setSource] = useState<Source>('blob');
  const [pointer, setPointer] = useState('');
  const [body, setBody] = useState('');

  const api = useCallback(async (method: 'GET' | 'POST', payload?: unknown) => {
    const r = await fetch(`/connect/library${scope}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error ?? `request failed (${r.status})`);
    return b;
  }, [token, scope]);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setItems((await api('GET')).artifacts ?? []); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { if (token) void load(); }, [token, load]);

  const add = async () => {
    if (!name.trim()) return;
    try {
      const artifact: Record<string, unknown> = { name: name.trim(), kind, source };
      if (source === 'blob') artifact.bytesB64 = btoa(body); else artifact.pointer = pointer.trim();
      await api('POST', { action: 'save', org: orgSa, artifact });
      setName(''); setBody(''); setPointer('');
      await load();
    } catch (e) { setErr((e as Error).message); }
  };
  const remove = async (id: string) => { try { await api('POST', { action: 'delete', org: orgSa, id }); await load(); } catch (e) { setErr((e as Error).message); } };
  const grant = async (id: string, granteeAddress: string, granteeKind: string, actions: string[], granteeLabel?: string) => {
    try { await api('POST', { action: 'grant', org: orgSa, id, grant: { granteeAddress, granteeKind, granteeLabel, actions } }); await load(); }
    catch (e) { setErr((e as Error).message); }
  };
  const revoke = async (id: string, granteeAddress: string) => { try { await api('POST', { action: 'revoke', org: orgSa, id, grant: { granteeAddress } }); await load(); } catch (e) { setErr((e as Error).message); } };

  return (
    <SectionShell title={orgSa ? 'Organization Library' : 'Library'}>
      <p style={mutedText}>
        Content Artifacts — SKILL.md, ontology <code style={mono}>.ttl</code>, docs, JSON-LD, and media —
        that this {orgSa ? 'organization' : 'person'} manages. Click an artifact to manage who can access it.
        A <code style={mono}>.ttl</code> may live in GraphDB and a JSON-LD record in a vault, not only unstructured storage.
      </p>
      {err && <p style={errorText}>{err}</p>}

      <div style={{ ...cardSty, marginTop: '1rem' }}>
        <b>Add an artifact</b>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginTop: '.5rem', alignItems: 'center' }}>
          <input style={inputSty} placeholder="name (e.g. create-skill, faith.ttl)" value={name} onChange={(e) => setName(e.target.value)} />
          <select style={inputSty} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          <select style={inputSty} value={source} onChange={(e) => setSource(e.target.value as Source)}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </div>
        {source === 'blob'
          ? <textarea style={{ ...inputSty, width: '100%', minHeight: 80, marginTop: '.5rem' }} placeholder="content (stored encrypted as bytes)" value={body} onChange={(e) => setBody(e.target.value)} />
          : <input style={{ ...inputSty, width: '100%', marginTop: '.5rem' }} placeholder="retrievalPointer (e.g. graphdb:faith/ontology · vault:0x…/record)" value={pointer} onChange={(e) => setPointer(e.target.value)} />}
        <div style={{ marginTop: '.5rem' }}><button style={btnPrimarySty} onClick={add}>Add artifact</button></div>
      </div>

      <div style={{ marginTop: '1rem' }}>
        {loading && <p style={mutedText}>loading…</p>}
        {!loading && items.length === 0 && <p style={mutedText}>No artifacts yet.</p>}
        {items.map((a) => (
          <div key={a.id} style={{ ...cardSty, marginTop: '.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
              <b>{a.name}</b>
              <span style={{ ...mutedText, fontSize: 12 }}>{a.kind} · {a.source}{a.pointer ? ` · ${a.pointer}` : ''}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem' }}>
                <button style={btnSty} onClick={() => setOpenId(openId === a.id ? null : a.id)}>Manage access ({a.grants.filter((g) => !g.revoked).length})</button>
                <button style={btnSty} onClick={() => void remove(a.id)}>Remove</button>
              </span>
            </div>
            {openId === a.id && <ManageAccess artifact={a} onGrant={grant} onRevoke={revoke} />}
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function ManageAccess({ artifact, onGrant, onRevoke }: {
  artifact: Artifact;
  onGrant: (id: string, addr: string, kind: string, actions: string[], label?: string) => void;
  onRevoke: (id: string, addr: string) => void;
}) {
  const [addr, setAddr] = useState('');
  const [gkind, setGkind] = useState('person');
  const [label, setLabel] = useState('');
  const [actions, setActions] = useState<string[]>(['read']);
  const toggle = (x: string) => setActions((a) => (a.includes(x) ? a.filter((y) => y !== x) : [...a, x]));
  return (
    <div style={{ marginTop: '.6rem', borderTop: '1px solid #2a2f3a', paddingTop: '.6rem' }}>
      <div style={{ ...mutedText, fontSize: 12 }}>Give another agent (person / organization / service) access to this artifact.</div>
      {artifact.grants.map((g) => (
        <div key={g.grantee.address} style={{ display: 'flex', gap: '.5rem', alignItems: 'center', margin: '.3rem 0', opacity: g.revoked ? 0.5 : 1 }}>
          <code style={mono}>{g.grantee.label ? `${g.grantee.label} · ` : ''}{g.grantee.address.slice(0, 10)}…</code>
          <span style={{ ...mutedText, fontSize: 12 }}>{g.grantee.kind} · {g.actions.join(', ')}{g.revoked ? ' · revoked' : ''}</span>
          {!g.revoked && <button style={btnSty} onClick={() => onRevoke(artifact.id, g.grantee.address)}>Revoke</button>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '.4rem' }}>
        <input style={inputSty} placeholder="grantee SA 0x…" value={addr} onChange={(e) => setAddr(e.target.value)} />
        <select style={inputSty} value={gkind} onChange={(e) => setGkind(e.target.value)}>{['person', 'org', 'service'].map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <input style={inputSty} placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        {ACTIONS.map((x) => (
          <label key={x} style={{ ...mutedText, fontSize: 12, display: 'inline-flex', gap: 3, alignItems: 'center' }}>
            <input type="checkbox" checked={actions.includes(x)} onChange={() => toggle(x)} />{x}
          </label>
        ))}
        <button style={btnPrimarySty} disabled={!/^0x[0-9a-fA-F]{40}$/.test(addr) || actions.length === 0}
          onClick={() => onGrant(artifact.id, addr, gkind, actions, label || undefined)}>Grant access</button>
      </div>
    </div>
  );
}
