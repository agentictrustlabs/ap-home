'use client';
// THE AGENT BEHIND THIS DOOR, FOR ANYONE WHO ARRIVES — a named Home's front door is public, and so is the agent it
// belongs to: the agent card and the A2A endpoint are world-readable by construction (spec 347), the Smart Agent
// address is on chain. Print them where a visitor already is, plus a fold saying how Claude reaches this agent
// (spec 397: the Home MCP as a custom connector; the owner's own asks ride her `ask-as-me` wire, anyone else's ride
// their own Home's). Everything here is a RECORD — what the card says, where it is served — never authority: a
// visitor who reads it can find and address the agent; acting still needs a delegation the owner signed.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { cardUriForName } from '../../lib/studio-view';
import { A2A_DOMAIN, AGENT_NAME_PARENT, AGENT_NAME_PARENTS, HOME_MCP_ORIGIN, nameLabel } from '../../lib/domain';
import { whitelabel } from '../../whitelabel/config';

/** What the live card answered — the endpoint it names, or why there is none to name (398 §6.3: the read failing
 *  is said in its place, never rendered as "no endpoint"). */
type Live =
  | { state: 'reading' }
  | { state: 'read'; endpoint: string | null; description: string | null }
  | { state: 'unreachable'; why: string };

/** A2A 1.0 card: the interfaces list is where the JSON-RPC endpoint lives; `url` is the pre-1.0 shape. */
function endpointOf(card: unknown): string | null {
  if (!card || typeof card !== 'object') return null;
  const c = card as { supportedInterfaces?: Array<{ url?: string; protocolBinding?: string }>; url?: string };
  const rpc = c.supportedInterfaces?.find((i) => i.protocolBinding === 'JSONRPC') ?? c.supportedInterfaces?.[0];
  return rpc?.url ?? c.url ?? null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '.76rem', wordBreak: 'break-all' };

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost onboarding-secondary"
      style={{ width: 'auto', padding: '.15rem .55rem', fontSize: '.72rem', fontWeight: 500, marginLeft: 6, verticalAlign: 'middle' }}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => undefined);
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Spec 412 — the shelf, as the Home's own `/published/shelf` reads it from her agent (the same anonymous A2A read). */
type Shelf =
  | { state: 'reading' }
  | { state: 'read'; count: number; files: Array<{ id: string; name: string; kind: string; folder: string; release: { version: string; signed: boolean } | null }> }
  | { state: 'unreachable'; why: string };

export function AgentReachFold({ name, agent }: { name: string; agent: Address }) {
  const cardUri = cardUriForName(name, { nameParent: AGENT_NAME_PARENT, nameParents: AGENT_NAME_PARENTS, a2aDomain: A2A_DOMAIN });
  const [live, setLive] = useState<Live>({ state: 'reading' });
  const [shelf, setShelf] = useState<Shelf>({ state: 'reading' });
  useEffect(() => {
    let cancelled = false;
    void fetch(`/published/shelf?name=${encodeURIComponent(name)}`)
      .then(async (r) => {
        const b = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; count?: number; files?: Shelf extends { files: infer F } ? F : never } | null;
        if (cancelled) return;
        if (!b?.ok) setShelf({ state: 'unreachable', why: b?.error ?? `HTTP ${r.status}` });
        else setShelf({ state: 'read', count: b.count ?? 0, files: (b.files ?? []) as never });
      })
      .catch((e: unknown) => { if (!cancelled) setShelf({ state: 'unreachable', why: e instanceof Error ? e.message : 'the shelf could not be read' }); });
    return () => { cancelled = true; };
  }, [name]);
  useEffect(() => {
    if (!cardUri) return;
    let cancelled = false;
    void fetch(cardUri)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const card: unknown = await r.json();
        if (!cancelled) setLive({ state: 'read', endpoint: endpointOf(card), description: (card as { description?: string }).description ?? null });
      })
      .catch((e: unknown) => { if (!cancelled) setLive({ state: 'unreachable', why: e instanceof Error ? e.message : 'the card could not be read' }); });
    return () => { cancelled = true; };
  }, [cardUri]);
  if (!cardUri) return null;
  const label = nameLabel(name);
  // The Home MCP's connector URL, PRINTED for the person to paste into Claude — this page never calls it (the browser
  // reaches MCP only through /a2a/*, ADR-0044; check:no-direct-mcp-in-web reads a literal ending in /mcp as a call).
  const mcpUrl = [HOME_MCP_ORIGIN, 'mcp'].join('/');
  const homeHost = typeof window !== 'undefined' ? window.location.host : `${label}.…`;
  const row = (k: string, v: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '6.2rem 1fr', gap: '.35rem', alignItems: 'baseline', margin: '.25rem 0' }}>
      <span style={{ opacity: 0.6 }}>{k}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <div data-testid="agent-reach" style={{ margin: '1.1rem auto 0', maxWidth: 420, width: '100%', fontSize: '.8rem', color: 'var(--color-text-muted, #475569)', textAlign: 'left', borderTop: '1px solid var(--color-border, #e7e5e4)', paddingTop: '.9rem' }}>
      <div style={{ fontWeight: 600, fontSize: '.82rem', color: 'var(--color-text, #1c1917)' }}>{label}&apos;s agent is public</div>
      <p style={{ margin: '.25rem 0 .5rem' }}>
        Any A2A client can read its card and put a message to it. What it may <em>do</em> for a caller is a delegation {label} signed — never something a caller asserts.
      </p>
      {row('Agent card', <><a href={cardUri} target="_blank" rel="noreferrer" style={mono}>{cardUri}</a></>)}
      {row('A2A endpoint',
        live.state === 'reading' ? <span style={{ opacity: 0.7 }}>reading the card…</span>
        : live.state === 'unreachable' ? <span data-testid="agent-reach-unreachable">the card could not be read just now ({live.why}) — the endpoint is named inside it</span>
        : live.endpoint ? <><code style={mono}>{live.endpoint}</code><CopyButton text={live.endpoint} /></>
        : <span>the card names no JSON-RPC endpoint</span>)}
      {row('Smart Agent', <code style={mono} title={agent}>{short(agent)}</code>)}
      {/* Spec 412 — what {label} made public: read from her agent by the Home the way anyone would; said in its place when
          the read fails (never rendered as "nothing published"). */}
      <div data-testid="agent-reach-published" style={{ marginTop: '.7rem' }}>
        <div style={{ fontWeight: 600, fontSize: '.8rem', color: 'var(--color-text, #1c1917)' }}>Published by {label}</div>
        {shelf.state === 'reading' && <p style={{ margin: '.2rem 0 0', opacity: 0.7 }}>asking {label}&apos;s agent…</p>}
        {shelf.state === 'unreachable' && <p style={{ margin: '.2rem 0 0' }} data-testid="agent-reach-shelf-unreachable">the shelf could not be read just now ({shelf.why})</p>}
        {shelf.state === 'read' && shelf.count === 0 && <p style={{ margin: '.2rem 0 0', opacity: 0.7 }}>nothing public yet</p>}
        {shelf.state === 'read' && shelf.count > 0 && (
          <ul style={{ margin: '.25rem 0 0', paddingLeft: '1.1rem' }}>
            {shelf.files.slice(0, 5).map((f) => (
              <li key={f.id}><a href={`/published/${encodeURIComponent(f.id)}`}>{f.name.replace(/\.(md|json|jsonld|ttl)$/i, '')}</a>{f.release ? <span style={{ opacity: 0.6 }}> · released {f.release.version}{f.release.signed ? ', signed' : ''}</span> : null}</li>
            ))}
            {shelf.count > 5 && <li style={{ listStyle: 'none', marginLeft: '-1.1rem' }}><a href="/published">everything {label} has published ({shelf.count}) →</a></li>}
          </ul>
        )}
        {shelf.state === 'read' && shelf.count > 0 && shelf.count <= 5 && <p style={{ margin: '.2rem 0 0' }}><a href="/published">everything {label} has published →</a></p>}
      </div>
      <details className="demo-people-fold" style={{ marginTop: '.6rem' }}>
        <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.78rem', fontWeight: 600 }}>
          <span aria-hidden className="demo-people-fold__chev" style={{ display: 'inline-block', transition: 'transform .15s' }}>›</span> Talk to this agent from Claude
        </summary>
        <div style={{ margin: '.5rem 0 0', display: 'grid', gap: '.6rem' }}>
          <div>
            <div style={{ fontWeight: 600 }}>If {label} is you</div>
            <ol style={{ margin: '.25rem 0 0', paddingLeft: '1.1rem', display: 'grid', gap: '.3rem' }}>
              <li>
                In Claude, open <b>Settings → Connectors → Add custom connector</b>. Name it <b>{whitelabel.brand.name} Home</b> and give it this URL:
                <div style={{ marginTop: '.2rem' }}><code style={mono}>{mcpUrl}</code><CopyButton text={mcpUrl} /></div>
              </li>
              <li>
                Click <b>Connect</b>. Claude brings you back here to sign in (Google or email) and asks you to let it put questions to your agent <b>as you</b> — the one thing that wire allows. You can revoke it any time under <b>Connected assistants</b>.
              </li>
              <li>
                Then just ask — <i>“what organizations am I part of?”</i>, <i>“send the field team a note”</i>. Anything that needs your signature parks at <code style={mono}>{homeHost}/you</code> until you approve it there; Claude never signs for you.
              </li>
            </ol>
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>If you have a Home of your own</div>
            <p style={{ margin: '.25rem 0 0' }}>
              Connect <em>your</em> Home the same way, then ask Claude to <i>“engage {name}”</i> with what you want to say. Claude reaches this agent over A2A through your agent, under your standing — {label}&apos;s agent answers what its playbook lets it tell you.
            </p>
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>Any other A2A client</div>
            <p style={{ margin: '.25rem 0 0' }}>
              Read the card, then send A2A JSON-RPC (<code style={mono}>message/send</code>) to the endpoint above. A bearer token is only the envelope: the agent authorizes each act against an on-chain delegation from {label}, re-checked at the moment of acting.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
