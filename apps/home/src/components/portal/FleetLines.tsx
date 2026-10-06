'use client';
// M06 — THE FLEET BOUNDARY, SHOWN — spec 398 §4.4: for each managed agent, three lines and not an avatar: WHERE IT
// RUNS (this deployment's runtime, its own serving object), WHAT IT MAY SPEND (the grants in force on it — its wires,
// 329), WHAT IT HOLDS (its own vault, whether its key is bound). Read from the same endpoints the planes and the
// vault-key ceremony use; absent is said absent.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { postA2a } from '../../home/ask';
import { A2A_DOMAIN, VAULT_SERVER_ID } from '../../lib/domain';

interface Facts {
  planes: { interactions: boolean | null; delivery: boolean | null; current: boolean | null };
  vault: { bound: boolean | null; resources: number };
}

export function FleetLines({ agent, token, stewardship, onActivateVault }: {
  agent: Address; token: string; /** the steward's wire — one of what it may spend */ stewardship?: boolean;
  /** The vault-key ceremony for THIS agent, signed as it by its steward. Given, an unbound vault gets an
   *  "Activate vault" action: Home binds only an ORG's vault at create, so a workspace or service agent
   *  chartered here otherwise has no way to get one (its Library reads "mcp: auth failed"). */
  onActivateVault?: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [f, setF] = useState<Facts | null>(null);
  const [rev, setRev] = useState(0);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const st = (await postA2a(`/a2a/interactions/${agent.toLowerCase()}/status`, { session: token }).catch(() => ({}))) as { granted?: boolean; current?: boolean; deliveryGranted?: boolean };
      const kb = (await fetch(`/mcp-bind/custody/vault-key/is-bound?owner=${agent.toLowerCase()}`).then((r) => r.json()).catch(() => ({}))) as { bound?: boolean; allowedResources?: string[] };
      if (!live) return;
      setF({
        planes: { interactions: st.granted ?? null, delivery: st.deliveryGranted ?? null, current: st.current ?? null },
        vault: { bound: kb.bound ?? null, resources: kb.allowedResources?.length ?? 0 },
      });
    })();
    return () => { live = false; };
  }, [agent, token, rev]);
  const spends = f
    ? [stewardship ? 'your stewardship wire' : null, f.planes.interactions ? `interactions plane${f.planes.current === false ? ' (stale — re-enable)' : ''}` : null, f.planes.delivery ? 'delivery plane' : null].filter(Boolean)
    : [];
  return (
    <div className="fleet-lines" data-testid="fleet-lines" style={{ fontSize: '0.72rem', opacity: 0.8, display: 'flex', flexDirection: 'column', gap: 1, marginTop: '0.3rem' }}>
      <div><span style={{ opacity: 0.6 }}>runs at</span> {A2A_DOMAIN} · its own serving object</div>
      <div><span style={{ opacity: 0.6 }}>may spend</span> {f === null ? '…' : spends.length ? spends.join(' · ') : 'nothing granted yet'}</div>
      <div><span style={{ opacity: 0.6 }}>holds</span> {f === null ? '…' : f.vault.bound ? `its own vault at ${VAULT_SERVER_ID} · key bound (${f.vault.resources} scope${f.vault.resources === 1 ? '' : 's'})` : 'no vault key bound yet'}
        {f?.vault.bound === false && onActivateVault && (
          <>
            {' · '}
            <button
              type="button"
              disabled={activating}
              style={{ font: 'inherit', textDecoration: 'underline', background: 'none', border: 0, padding: 0, cursor: activating ? 'wait' : 'pointer' }}
              onClick={() => {
                setActivating(true);
                setActivateError(null);
                void onActivateVault()
                  .then((r) => { if (!r.ok) setActivateError(r.error ?? 'could not activate the vault'); setRev((n) => n + 1); })
                  .catch((e: unknown) => setActivateError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setActivating(false));
              }}
            >
              {activating ? 'activating…' : 'Activate vault'}
            </button>
          </>
        )}
        {activateError && <span style={{ color: 'var(--danger, #b42318)' }}> · {activateError}</span>}
      </div>
    </div>
  );
}
