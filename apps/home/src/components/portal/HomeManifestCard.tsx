'use client';
// Publish your Home manifest (spec 310 W2) — the signed, portable document
// other agents resolve at <label>.<domain>/.well-known/agentic-home to learn
// what your Home serves (SSO/A2A endpoints, surfaces, inbox capabilities).
// Your ROOT credential signs the manifest digest — the same signer that issues
// your delegations; the manifest itself grants nothing.
import { useCallback, useEffect, useState } from 'react';
import type { Address, Hex } from '@agenticprimitives/types';
import type { HomeManifestV1 } from '@agenticprimitives/home';
import { passkeySignHash, googleSignHash, type SignHash } from '../../connect-client';
import { connectWallet, personalSign } from '../../lib/wallet';
import { nameLabel } from '../../lib/domain';
import { useSession } from '../../context/session';
import {
  buildHomeManifestDraft,
  finalizeHomeManifest,
  homeCaip10,
  homeManifestDigest,
} from '../../home/manifest';

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') {
    const addr = await connectWallet();
    return (h) => personalSign(addr, h);
  }
  if (v === 'google') return googleSignHash(agent, token);
  return passkeySignHash;
}

export function HomeManifestCard() {
  const { session, agentAddress, agentName } = useSession();
  const label = agentName ? nameLabel(agentName) : null;
  const [current, setCurrent] = useState<HomeManifestV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!label) return;
    try {
      const res = await fetch(`/connect/home-manifest?label=${encodeURIComponent(label)}`);
      const body = (await res.json()) as { manifest?: HomeManifestV1 | null };
      setCurrent(body.manifest ?? null);
    } catch {
      setCurrent(null);
    }
  }, [label]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const publish = useCallback(async () => {
    if (!session || !agentAddress || !label) return;
    setBusy(true);
    setMsg(null);
    try {
      const draft = buildHomeManifestDraft({ label, owner: agentAddress as Address, nowMs: Date.now() });
      const digest = homeManifestDigest(draft);
      const sign = await signerFor(session.via, agentAddress as Address, session.token);
      const signature = (await sign(digest)) as Hex;
      const manifest = finalizeHomeManifest(draft, {
        signer: homeCaip10(agentAddress as Address),
        scheme: 'erc1271',
        signature,
      });
      const res = await fetch('/connect/home-manifest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ label, manifest }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `publish failed (${res.status})`);
      setMsg('Home manifest published.');
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session, agentAddress, label, refresh]);

  if (!session || !agentAddress) return null;

  // The manifest publishes under the name's subdomain — without a claimed
  // name there is nowhere to serve it. Say so instead of hiding (fail-visible).
  if (!label) {
    return (
      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Your Home manifest</h2>
        <p style={{ opacity: 0.8 }}>
          Publishing needs a claimed agent name — the manifest is served at{' '}
          <code>{'<name>.…/.well-known/agentic-home'}</code> and the server verifies the name
          resolves to your agent on-chain. Claim your name first, then publish from here.
        </p>
      </div>
    );
  }

  return (
    <div className="dash-section" style={{ marginTop: '1.5rem' }}>
      <h2>Your Home manifest</h2>
      <p style={{ opacity: 0.8 }}>
        The signed document other agents read at{' '}
        <code>{`${label}.…/.well-known/agentic-home`}</code> to discover your Home&apos;s surfaces
        and inbox capabilities. It describes; it never grants.
      </p>
      {current ? (
        <p>
          Published — valid until{' '}
          <b>{current.validUntil ? new Date(current.validUntil).toLocaleDateString() : 'no expiry'}</b>.
        </p>
      ) : (
        <p>Not published yet.</p>
      )}
      <button className="btn" onClick={() => void publish()} disabled={busy}>
        {busy ? 'Signing…' : current ? 'Re-publish (re-sign)' : 'Publish Home manifest'}
      </button>
      {msg && <p style={{ marginTop: '0.5rem' }}>{msg}</p>}
    </div>
  );
}
