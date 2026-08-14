'use client';
// PER-APP READ GRANTS (spec 341 §4.3) — the member's own control over which apps may read which
// of their records.
//
// The machinery landed in `src/lib/read-grants.ts` and until now nothing drove it, which meant a
// scoped grant was issuable and inert: a relying app asking for the person's inbox got
// `read_grant_absent` and the person had no way to answer it. This panel is that way.
//
// WHY IT IS A SEPARATE DECISION FROM CONNECTING. Connecting an app proves who you are to it.
// Letting it read your mail is a different question with a different answer, and bundling them
// would make "sign in" a single coarse yes — which is the property per-app grants exist to end.
//
// WHAT THE GRANT IS. A delegation the PERSON signs: read-only by construction (`ops: ['read']`),
// scoped to a named record family (never `vault:*` — the builder refuses it), time-bounded, and
// revocable on-chain. The delegate is the interactions service SA, not the app: the app never
// touches the vault itself, and what varies per app is WHICH delegation authorizes the read and
// therefore what a revocation kills.
//
// WHAT "REMOVE" DOES, said plainly on the card because the distinction is the whole point:
// it drops this Home's copy. The authority kill is the on-chain revoke, which stops the app at
// every gate that checks — not just at this one.

import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { signHashFor, type Via } from '../../home/onboarding';
import { INTERACTIONS_SERVICE_SA, MCP_SERVER_ID } from '../../lib/inbox-delivery';
import {
  CAPABILITY_READ_RESOURCES,
  INBOX_READ_RESOURCES,
  dropReadGrant,
  issueReadGrant,
  listReadGrants,
  putReadGrant,
} from '../../lib/read-grants';

interface GrantRow {
  clientId: string;
  hash: string;
  storedAt: string;
  revoked: boolean;
}

/** What a person can authorize, and the plain-language version of what it covers. */
const FAMILIES = [
  {
    id: 'inbox',
    label: 'Your messages',
    body: 'Read your inbox and the message bodies in it. Read-only — an app with this cannot send, edit, or delete.',
    resources: INBOX_READ_RESOURCES,
  },
  {
    id: 'capabilities',
    label: 'Your capabilities',
    body: 'Read the private record of what you can do — the one your published profile is chosen from.',
    resources: CAPABILITY_READ_RESOURCES,
  },
] as const;

export function AppReadGrants() {
  const { session, agentAddress } = useSession();
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [clientId, setClientId] = useState('');
  const [family, setFamily] = useState<(typeof FAMILIES)[number]['id']>('inbox');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!agentAddress) return;
    try {
      setGrants(await listReadGrants(agentAddress as Address));
    } catch (e) {
      // A person who has never enabled interactions storage has no grant store yet. That is a
      // state, not a failure — say so instead of showing a stack trace.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [agentAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  const authorize = async () => {
    const id = clientId.trim().toLowerCase();
    if (!id || !agentAddress || !session) return;
    if (!INTERACTIONS_SERVICE_SA) {
      // Fail loudly rather than signing a grant whose delegate nothing can present. A grant to an
      // unprovisioned service is a credential that looks issued and refuses at every read.
      setError('This deployment has no interactions service agent provisioned, so a read grant would be inert.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const resources = FAMILIES.find((f) => f.id === family)?.resources ?? INBOX_READ_RESOURCES;
      const signHash = await signHashFor(session.via.toLowerCase() as Via, agentAddress as Address, {
        token: session.token,
      });
      const grant = await issueReadGrant({
        personSA: agentAddress as Address,
        serviceSA: INTERACTIONS_SERVICE_SA,
        resources,
        server: MCP_SERVER_ID,
        signHash,
      });
      await putReadGrant(agentAddress as Address, id, grant);
      setClientId('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!agentAddress) return;
    setBusy(true);
    setError('');
    try {
      await dropReadGrant(agentAddress as Address, id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!agentAddress || !session) return null;

  return (
    <div className="dash-section read-grants">
      <h3>Apps that may read your records</h3>
      <p className="muted">
        Signing in tells an app who you are. Letting it read your records is a separate yes — one you
        give per app, per record family, and can withdraw for one app without touching any other.
      </p>

      {error && <p className="settings-banner settings-banner--error">{error}</p>}

      <div className="settings-field">
        <label htmlFor="grant-client">App ID</label>
        <input
          id="grant-client"
          value={clientId}
          placeholder="commons-app"
          onChange={(e) => setClientId(e.target.value)}
        />
        <p className="settings-field__help">
          The app&apos;s <code>client_id</code> — the same value it signs in with, and the one this Home
          verifies on every call. The app can tell you what its id is.
        </p>
      </div>

      <div className="settings-field">
        <label>What it may read</label>
        {FAMILIES.map((f) => (
          <label key={f.id} className="read-grants__choice">
            <input
              type="radio"
              name="grant-family"
              checked={family === f.id}
              onChange={() => setFamily(f.id)}
            />
            <span>
              <strong>{f.label}</strong>
              <br />
              {f.body}
            </span>
          </label>
        ))}
        <p className="settings-field__help">
          Read-only by construction, scoped to that family alone, and time-bounded. It cannot be widened
          into a whole-vault grant — the builder refuses one.
        </p>
      </div>

      <button className="btn-primary" disabled={busy || !clientId.trim()} onClick={() => void authorize()}>
        {busy ? 'Signing…' : 'Authorize with my credential'}
      </button>

      <div className="read-grants__list">
        {loaded && grants.length === 0 && <p className="muted">No app can read your records yet.</p>}
        {grants.map((g) => (
          <div key={g.clientId} className="read-grants__row">
            <div>
              <strong>{g.clientId}</strong>
              {g.revoked && <span className="badge"> revoked on-chain</span>}
              <p className="settings-field__help">
                authorized {new Date(g.storedAt).toLocaleString()} · <code>{g.hash.slice(0, 18)}…</code>
              </p>
            </div>
            <button className="btn-ghost" disabled={busy} onClick={() => void remove(g.clientId)}>
              Remove
            </button>
          </div>
        ))}
        {grants.length > 0 && (
          <p className="settings-field__help">
            <strong>Remove</strong> drops this Home&apos;s copy, which stops the app here. The authority kill
            is revoking the delegation on-chain — that stops it at every gate that checks, including ones
            this Home does not operate. The status above is read from the chain, not from the stored row,
            so a revoke that landed is visible here.
          </p>
        )}
      </div>
    </div>
  );
}
