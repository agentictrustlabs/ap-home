'use client';
// The deployed substrate's live status — a2a / mcp health, the chain head, and the on-chain contract
// registry. SHARED by the person's Network page and every workspace's, deliberately: a workspace does
// not have a backend of its own, it answers on this one. Scoping this per agent would invent a
// distinction that does not exist.
// Network (ported from the impact app) — live status of the deployed backends and the chain
// they sit on. Everything here is a secret-free read:
//   • demo-a2a  → same-origin '/a2a/health' + '/a2a/deployments' (next.config.mjs rewrite);
//   • demo-mcp  → same-origin '/mcp-bind/health' (the spec 278 P5 rewrite already fronts
//     demo-mcp — reused here instead of a cross-origin fetch, so CORS never enters the picture);
//   • block height → public JSON-RPC (sepolia.base.org) polled every 12s, chain named from
//     the a2a health's chainId.
// Impact's env-configured backend module was NOT ported — the handful of read helpers below
// are inlined against this app's proxies.
import { useEffect, useState } from 'react';
import { SectionShell } from '../portal/SectionShell';
import { VAULT_SERVER_ID } from '../../lib/domain';

// ── Backend read shapes + helpers (impact's src/lib/backend.ts, trimmed to this page) ──
interface Health {
  ok: boolean;
  service: string;
  chainId: number;
  factory?: string;
  runtime?: string;
}

interface Deployments {
  chainId: number;
  [k: string]: string | number;
}

interface McpHealth { ok: boolean; service: string }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Public JSON-RPC block height. The rewrite proxy also exposes '/a2a/rpc', but the status page
 *  deliberately reads the PUBLIC endpoint — it measures the chain, not our relayer. */
const PUBLIC_RPC = 'https://sepolia.base.org';
async function getBlockNumber(): Promise<number> {
  const res = await fetch(PUBLIC_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  if (!res.ok) throw new Error(`eth_blockNumber → HTTP ${res.status}`);
  const json = (await res.json()) as { result?: string; error?: { message: string } };
  if (json.error || !json.result) throw new Error(json.error?.message ?? 'no result');
  return parseInt(json.result, 16);
}

const CHAIN_NAME: Record<number, string> = { 84532: 'Base Sepolia', 8453: 'Base' };
const explorer = (chainId: number) => (chainId === 84532 ? 'https://sepolia.basescan.org' : 'https://basescan.org');

const REGISTRY_LABELS: Record<string, string> = {
  delegationManager: 'Delegation Manager',
  agentAccountFactory: 'Agent Account Factory',
  timestampEnforcer: 'Timestamp Enforcer',
  allowedTargetsEnforcer: 'Allowed-Targets Enforcer',
  allowedMethodsEnforcer: 'Allowed-Methods Enforcer',
  valueEnforcer: 'Value Enforcer',
  universalSignatureValidator: 'Universal Signature Validator',
  agentNameRegistry: 'Agent Name Registry',
  agentNameUniversalResolver: 'Agent Name Resolver',
};

export function NetworkPanel() {
  const [a2a, setA2a] = useState<Health | null>(null);
  const [mcp, setMcp] = useState<McpHealth | null>(null);
  const [deploy, setDeploy] = useState<Deployments | null>(null);
  const [block, setBlock] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [h, d] = await Promise.all([getJson<Health>('/a2a/health'), getJson<Deployments>('/a2a/deployments')]);
        if (!alive) return;
        setA2a(h);
        setDeploy(d);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : 'backend unreachable');
      }
      // demo-mcp health through the same-origin bind proxy — optional, shows 'unreachable' on failure.
      try {
        const m = await getJson<McpHealth>('/mcp-bind/health');
        if (alive) setMcp(m);
      } catch { /* mcp optional */ }
    })();

    async function tickBlock() {
      try { const bn = await getBlockNumber(); if (alive) setBlock(bn); } catch { /* transient — keep last */ }
    }
    void tickBlock();
    const t = setInterval(() => void tickBlock(), 12000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const chainId = a2a?.chainId ?? deploy?.chainId ?? 84532;
  const base = explorer(chainId);
  const registryRows = deploy
    ? Object.entries(deploy).filter(([, v]) => typeof v === 'string' && String(v).startsWith('0x'))
    : [];

  return (
    <SectionShell title="Network">
      {err && (
        <div className="manage-card" style={{ marginBottom: '1.2rem', color: 'var(--color-danger)', background: 'var(--color-danger-subtle)' }}>
          Backend unreachable: {err}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '.8rem', marginBottom: '1.4rem' }}>
        <StatTile num={CHAIN_NAME[chainId] ?? `Chain ${chainId}`} label={`chainId ${chainId}`} />
        <StatTile num={block !== null ? `#${block.toLocaleString()}` : '…'} label="Current block (live, 12s)" />
        <StatTile num={`${[a2a?.ok, mcp?.ok].filter(Boolean).length}/2`} label="Backends healthy" />
      </div>

      <div className="dash-section">
        <h2>Services</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '.8rem' }}>
          <ServiceCard label="demo-a2a" sub="relayer · custody bridge · vault proxy" ok={!!a2a?.ok} detail={a2a?.runtime} />
          <ServiceCard label={VAULT_SERVER_ID} sub="vault · vault-key bind ceremony" ok={!!mcp?.ok} detail={mcp?.service ?? (mcp ? undefined : 'unreachable')} />
        </div>
      </div>

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>On-chain contract registry</h2>
        <p className="manage-card-blurb" style={{ marginBottom: '.65rem' }}>
          Pulled live from demo-a2a <code>/deployments</code>. Click a row to open the block explorer.
        </p>
        <div className="manage-card" style={{ padding: 0, overflow: 'hidden' }}>
          {registryRows.length === 0 && <div className="manage-card-blurb" style={{ padding: '.8rem 1.2rem' }}>Loading registry…</div>}
          {registryRows.map(([k, v], i) => (
            <a
              key={k}
              href={`${base}/address/${v}`}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem',
                padding: '.8rem 1.2rem', textDecoration: 'none', color: 'inherit',
                borderTop: i ? '1px solid var(--color-border)' : undefined,
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{REGISTRY_LABELS[k] ?? k}</div>
                <code style={{ fontSize: '.72rem', color: 'var(--color-text-faint)' }}>{k}</code>
              </div>
              <code style={{ fontSize: '.78rem', color: 'var(--color-text-muted)' }}>
                {String(v).slice(0, 10)}…{String(v).slice(-8)}
              </code>
            </a>
          ))}
        </div>
      </div>

      <p style={{ fontSize: '.78rem', marginTop: '1rem', color: 'var(--color-text-faint)' }}>
        Live now: health, chain, block, contract registry. Authenticated ceremonies — vault
        read/write, custody bootstrap, delegation signing — bind through the same '/a2a' layer once
        a session is connected.
      </p>
    </SectionShell>
  );
}

function StatTile({ num, label }: { num: string; label: string }) {
  return (
    <div className="manage-card">
      <div style={{ fontSize: '1.35rem', fontWeight: 900, color: 'var(--color-text-primary)' }}>{num}</div>
      <div className="manage-card-blurb" style={{ marginTop: '.15rem' }}>{label}</div>
    </div>
  );
}

function ServiceCard({ label, sub, ok, detail }: { label: string; sub: string; ok: boolean; detail?: string }) {
  return (
    <div className="manage-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.6rem' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem', flexWrap: 'wrap' }}>
          <strong style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '.9rem' }}>{label}</strong>
          {detail && <span style={{ fontSize: '.72rem', color: 'var(--color-text-faint)' }}>{detail}</span>}
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--color-text-muted)' }}>{sub}</div>
      </div>
      <span
        className={`manage-card-badge ${ok ? 'live' : ''}`}
        style={ok ? undefined : { background: 'var(--color-danger-subtle)', color: 'var(--color-danger)' }}
      >
        {ok ? 'healthy' : 'down'}
      </span>
    </div>
  );
}
