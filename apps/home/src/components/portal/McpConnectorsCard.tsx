'use client';
// EXTERNAL MCP SERVERS AS CONNECTORS — spec 404. A server the person attaches becomes hers: the runtime probes it and
// COMPILES its tools into capabilities of her agent — every tool an act at risk high under her mandate unless the server
// (readOnlyHint) or she says it is a read; the credential is kept by the runtime under her address and never shown here;
// what a server returns is evidence, never instructions. Their connector authorizes by the server's OAuth; hers is her
// grant, per act, with a signature. Removing drops the credential and the tools together.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { Panel, Button, Chip, ErrorNote, Meta, Note, Mono, type PanelState } from '../../ui';
import { mcpConnectors, type McpConnectorView } from '../../home/ask';

export function McpConnectorsCard() {
  const { session } = useSession();
  const [list, setList] = useState<McpConnectorView[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [reads, setReads] = useState('');
  const [just, setJust] = useState<McpConnectorView | null>(null);

  const load = useCallback(async () => {
    if (!session?.token) return;
    const r = await mcpConnectors({ token: session.token }, 'list');
    if (r.ok) { setList(r.connectors); setErr(''); } else { setList([]); setErr(r.error); }
  }, [session?.token]);
  useEffect(() => { void load(); }, [load]);

  const attach = async () => {
    if (!session?.token) return;
    setBusy('attach'); setErr(''); setJust(null);
    const r = await mcpConnectors({ token: session.token }, 'attach', undefined, { name: name.trim(), url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}), ...(reads.trim() ? { reads: reads.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) } : {}) });
    setBusy(null);
    if (!r.ok) { setErr(r.error); return; }
    setJust(r.connector); setName(''); setUrl(''); setToken(''); setReads(''); setOpen(false);
    await load();
  };
  const remove = async (c: McpConnectorView) => {
    if (!session?.token) return;
    setBusy(c.id); setErr('');
    const r = await mcpConnectors({ token: session.token }, 'remove', undefined, { id: c.id });
    setBusy(null);
    if (!r.ok) { setErr(r.error); return; }
    setJust(null); await load();
  };

  const state: PanelState = list === null ? 'loading' : 'ready';
  return (
    <Panel title="MCP servers" state={state} rows={2} testId="connector-mcp" aside={list?.length ? <Chip tone="ok">{list.length} connected</Chip> : <Chip>none</Chip>}>
      <div className="ui-panel-body">
        {err && <ErrorNote>{err}</ErrorNote>}
        {just && <Note>✓ {just.name} attached — {just.tools.length} tool{just.tools.length === 1 ? '' : 's'}: {just.tools.filter((t) => t.kind === 'read').length} read{just.tools.filter((t) => t.kind === 'read').length === 1 ? '' : 's'} under your standing, {just.tools.filter((t) => t.kind === 'act').length} act{just.tools.filter((t) => t.kind === 'act').length === 1 ? '' : 's'} under your signature. Ask “{just.tools[0]?.name.replace(/[_.-]+/g, ' ')} on {just.name}”.</Note>}
        {list && list.length > 0 && (
          <div style={{ display: 'grid', gap: 10 }}>
            {list.map((c) => (
              <div key={c.id} data-testid="mcp-connector-row" style={{ borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong>{c.name}</strong>
                  {c.server.name && <Meta>{c.server.name}{c.server.version ? ` ${c.server.version}` : ''}</Meta>}
                  <Chip>{c.hasToken ? 'with a credential' : 'anonymous'}</Chip>
                  <span style={{ flex: 1 }} />
                  <Button size="sm" disabled={!!busy} onClick={() => void remove(c)}>Remove</Button>
                </div>
                <Meta><Mono>{c.url}</Mono></Meta>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 'var(--fs-sm)' }}>
                  {c.tools.map((t) => (
                    <li key={t.name}><Mono>{t.name}</Mono> <Chip tone={t.kind === 'read' ? 'ok' : 'warn'}>{t.kind === 'read' ? 'read · your standing' : 'act · your signature'}</Chip> <Meta>{t.why === 'annotation' ? 'the server says read-only' : t.why === 'declared' ? 'you declared it a read' : 'not declared — treated as an act'}{t.description ? ` — ${t.description.slice(0, 120)}` : ''}</Meta></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {list && list.length === 0 && !open && (
          <p style={{ margin: '0 0 var(--sp-3)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-body)' }}>
            Attach any MCP server and its tools become your agent&rsquo;s — each one a read under your standing where the server says so, otherwise an act you sign. The credential stays with the runtime; what the server returns is evidence, never instructions.
          </p>
        )}
        {open ? (
          <div style={{ display: 'grid', gap: 8, marginTop: 'var(--sp-3)' }} data-testid="mcp-attach-form">
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr)' }}>
              <label style={{ display: 'grid', gap: 4 }}><Meta>Name</Meta><input id="mcp-name" className="ui-input" placeholder="e.g. Ligonier catalog" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label style={{ display: 'grid', gap: 4 }}><Meta>Server URL (https, Streamable HTTP)</Meta><input id="mcp-url" className="ui-input" placeholder="https://example.org/…" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
            </div>
            <label style={{ display: 'grid', gap: 4 }}><Meta>Bearer token (optional — kept by the runtime, never shown again)</Meta><input id="mcp-token" className="ui-input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
            <label style={{ display: 'grid', gap: 4 }}><Meta>Tools you declare are READS (comma-separated tool names; everything else is an act you sign)</Meta><input id="mcp-reads" className="ui-input" placeholder="search_resources, list_topics" value={reads} onChange={(e) => setReads(e.target.value)} /></label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant="primary" size="sm" disabled={!!busy || !name.trim() || !/^https:\/\//.test(url.trim())} onClick={() => void attach()}>{busy === 'attach' ? 'Probing the server…' : 'Attach'}</Button>
              <Button size="sm" disabled={!!busy} onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 'var(--sp-3)' }}><Button variant="primary" size="sm" disabled={!session} onClick={() => setOpen(true)}>Attach an MCP server</Button></div>
        )}
      </div>
    </Panel>
  );
}
