'use client';
// /reader-pass — buy a licensed-edition READER'S PASS that no one can trace back to you (private-scripture W3;
// verifiable-content-demo `docs/private-scripture-spec.md`). An app sends the member here the way it sends them to
// /choose-treasury, and the same gate runs first:
//
//   /reader-pass?client_id=…&redirect_uri=…&state=…
//
//   success   ?reader_pass=issued&valid_until=<day number>&state=…
//   declined  ?reader_pass_error=denied&state=…
//
// What happens on "Buy", in ONE call under the member's own login (`POST /a2a/reader-pass/buy`): her PURSE — a treasury
// whose custodian is her login on its own derivation path, sharing nothing with her person account on chain — pays the
// publisher; a fresh DEVICE KEY is made for her in her key service; the purse signs the claim; the publisher's agent
// issues an OpenAC reader credential bound to that key, without being told who she is; and her vault keeps it. Then the
// purse is linked to her in HER OWN relationship records (never on chain), so her Home can show it.
//
// The answer carries no credential, no address and no purse: the app learns that a pass was issued and until when.
import { useEffect, useState } from 'react';
import { SessionProvider, useSession } from '../../src/context/session';
import { EntryExperience } from '../../src/components/onboarding/EntryExperience';
import { BrandShield } from '../../src/components/shared/BrandShield';
import { knownRelyingClient, primeRelyingClient } from '../../src/lib/relying-clients';
import { parseTreasuryRequest, refusalFor, type TreasuryRefusal, type TreasuryRequest } from '../../src/lib/treasury-ceremony';
import type { OidcClient } from '../../src/lib/oidc-clients';
import { ensureCsrfToken, csrfHeaders } from '../../src/csrf';
import { whitelabel } from '../../src/whitelabel/config';

type Check = { k: 'checking' } | { k: 'ok'; req: TreasuryRequest; client: OidcClient } | { k: 'refused'; refusal: TreasuryRefusal };
type Buy = { k: 'idle' } | { k: 'busy' } | { k: 'done'; validUntil: number } | { k: 'failed'; said: string };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', alignSelf: 'flex-start' }}>
          <BrandShield size={28} />
          <strong style={{ fontWeight: 800, color: 'var(--color-text-primary)' }}>{whitelabel.brand.name}</strong>
        </div>
        {children}
      </div>
    </div>
  );
}

function returnUrl(req: TreasuryRequest, result: { validUntil: number } | { error: 'denied' }): string {
  const url = new URL(req.redirectUri);
  if ('error' in result) url.searchParams.set('reader_pass_error', result.error);
  else { url.searchParams.set('reader_pass', 'issued'); url.searchParams.set('valid_until', String(result.validUntil)); }
  url.searchParams.set('state', req.state);
  return url.toString();
}

const dateOf = (day: number): string => new Date(day * 86_400_000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

function Body() {
  const { phase, session, agentAddress } = useSession();
  const [check, setCheck] = useState<Check>({ k: 'checking' });
  const [buy, setBuy] = useState<Buy>({ k: 'idle' });

  useEffect(() => {
    const req = parseTreasuryRequest(window.location.href);
    if (!req) { setCheck({ k: 'refused', refusal: refusalFor(null, null)! }); return; }
    let live = true;
    void primeRelyingClient(req.clientId).then(() => {
      if (!live) return;
      const client = knownRelyingClient(req.clientId);
      const refusal = refusalFor(req, client);
      setCheck(refusal ? { k: 'refused', refusal } : { k: 'ok', req, client: client! });
    });
    return () => { live = false; };
  }, []);

  if (check.k === 'checking') return <Shell><div className="onboarding-busy"><span className="spinner spinner-lg" role="status" aria-label="Checking the request" /><p className="onboarding-busy-msg">Checking who sent you…</p></div></Shell>;
  if (check.k === 'refused') {
    return (
      <Shell>
        <h1 className="onboarding-h1">We didn&apos;t open this</h1>
        <p className="onboarding-sub">{check.refusal.check === 'client_id' ? `${whitelabel.brand.name} does not recognise the app that sent you here.` : 'That request could not be verified, so nothing has happened.'}</p>
        <p className="onboarding-hint">Refused at: <strong>{check.refusal.check}</strong> — {check.refusal.detail}</p>
      </Shell>
    );
  }
  if (phase === 'restoring') return <Shell><div className="onboarding-busy"><span className="spinner spinner-lg" role="status" aria-label="Opening your home" /><p className="onboarding-busy-msg">Opening your home…</p></div></Shell>;
  if (phase !== 'authed' || !session?.token || !agentAddress) return <EntryExperience mode="entry" />;

  const { req, client } = check;
  const appName = client.name ?? 'The app';

  async function purchase() {
    setBuy({ k: 'busy' });
    try {
      await ensureCsrfToken();
      const res = await fetch('/a2a/reader-pass/buy', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ session: session!.token }) });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string; purse?: string; validUntil?: number };
      if (!res.ok || !out.ok || typeof out.validUntil !== 'number') {
        const custody = res.status === 403 && /oidc|custody/i.test(out.error ?? '');
        setBuy({ k: 'failed', said: custody ? 'A private pass needs the sign-in that secures your account (Google today). Sign out, sign in with it, and try again.' : [out.error, out.detail].filter(Boolean).join(' — ') || `The pass could not be bought (HTTP ${res.status}).` });
        return;
      }
      // Her own record of her purse — in her vault, never on chain, so her Home can list it. Best-effort: the pass is hers either way.
      if (out.purse) {
        await fetch('/connect/related-orgs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session!.token}` }, body: JSON.stringify({ person: agentAddress, orgAgent: out.purse, orgName: '', kind: 'purse', parent: agentAddress, relationship: 'steward', purpose: 'reader-pass purse' }) }).catch(() => undefined);
      }
      setBuy({ k: 'done', validUntil: out.validUntil });
    } catch (e) {
      setBuy({ k: 'failed', said: e instanceof Error ? e.message : String(e) });
    }
  }

  if (buy.k === 'done') {
    return (
      <Shell>
        <h1 className="onboarding-h1">Your reader&apos;s pass is ready</h1>
        <p className="onboarding-sub">You can read the licensed edition until <strong>{dateOf(buy.validUntil)}</strong>. The pass is in your vault, tied to a key no one else holds.</p>
        <p className="onboarding-hint">The publisher issued it without learning who you are, and {appName} is told only that a pass exists and until when.</p>
        <button className="btn-primary" onClick={() => { window.location.href = returnUrl(req, { validUntil: buy.validUntil }); }}>Back to {appName}</button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="onboarding-h1">A private reader&apos;s pass</h1>
      <p className="onboarding-sub">{appName} would like you to read the licensed <strong>LBSB</strong> edition. A pass costs <strong>1 test USDC</strong> and lasts <strong>30 days</strong>.</p>
      <ul className="onboarding-sub" style={{ textAlign: 'left', margin: '0 0 .75rem', paddingLeft: '1.2rem' }}>
        <li>It is paid from a <strong>purse</strong> of yours that carries no name and shares nothing with your account on chain. On this test chain the purse fills itself.</li>
        <li>The publisher issues the pass to a <strong>new key</strong> made for you, and never learns who you are.</li>
        <li>Each question you ask with it travels under a <strong>new pen name</strong>.</li>
      </ul>
      {buy.k === 'failed' && <p className="onboarding-error" role="alert">{buy.said}</p>}
      <button className="btn-primary" disabled={buy.k === 'busy'} onClick={() => void purchase()}>{buy.k === 'busy' ? 'Buying your pass…' : 'Buy a private pass'}</button>
      <button className="btn-ghost" disabled={buy.k === 'busy'} onClick={() => { window.location.href = returnUrl(req, { error: 'denied' }); }}>Not now</button>
    </Shell>
  );
}

export default function ReaderPassPage() {
  return (
    <SessionProvider>
      <Body />
    </SessionProvider>
  );
}
