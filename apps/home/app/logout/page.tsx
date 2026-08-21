'use client';
// Full SSO sign-out (spec 264 / ADR-0032 follow-up). A relying app sends the member here
// (`/logout?return=<rp-url>`) when they disconnect: we END the impact home session — clear the
// cross-subdomain `ap_sso` cookie + this origin's stored session — and signal FedCM logged-out so it
// won't auto-recognize the member on the next connect, then bounce back to the relying app.
//
// A TOP-LEVEL navigation (not a hidden iframe) is deliberate: `navigator.login.setStatus` and the cookie
// clear must apply to the IdP origin itself, and Chrome restricts `setStatus` from cross-site iframes.
// Same reason we notify Commons with a top-level GET: its session cookie is SameSite=Lax, so a
// hidden iframe from this origin would not send it. Front-channel logout is a navigation.
import { useEffect } from 'react';
import { clearSsoCookie } from '../../src/lib/sso-cookie';
import { setFedcmLoginStatus, SESSION_KEY } from '../../src/context/session';
import { getClient, isAllowedRelyingOrigin } from '../../src/lib/oidc-clients';
import { disconnectWallet } from '../../src/lib/wallet';

/** Commons keeps its own cookie. Tell it the Home session ended — https from prod, loopback from local. */
function commonsFrontChannelLogout(): string | null {
  const client = getClient('commons-app');
  if (!client) return null;
  const hereHttps = window.location.protocol === 'https:';
  for (const uri of client.redirect_uris) {
    try {
      const u = new URL(uri);
      if (hereHttps && u.protocol !== 'https:') continue;
      if (!hereHttps && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') continue;
      return new URL('/sso-logout', u.origin).toString();
    } catch {
      /* skip a malformed registered URI */
    }
  }
  return null;
}

export default function LogoutPage() {
  useEffect(() => {
    try {
      localStorage.removeItem(SESSION_KEY); // this origin's persisted session
    } catch {
      /* storage blocked — fine */
    }
    clearSsoCookie(); // end the cross-subdomain `.impact-agent.me` SSO session
    setFedcmLoginStatus('logged-out'); // FedCM: don't auto-recognize / show the chooser next time
    // This page tears the session down directly (not via session.signOut), so also drop the dApp
    // from MetaMask's "Connected sites" here (EIP-2255). Best-effort + silent; no-op for non-wallet.
    void disconnectWallet();

    // Anti open-redirect: registered relying-app origin, or this Home origin, otherwise the apex.
    const params = new URL(window.location.href).searchParams;
    let dest = `${window.location.origin}/`;
    try {
      const ret = params.get('return');
      if (ret) {
        const u = new URL(ret, window.location.origin);
        if (u.origin === window.location.origin || isAllowedRelyingOrigin(ret)) dest = u.toString();
      }
    } catch {
      /* malformed return — stay on this Home */
    }

    // Commons' /sso-logout return allowlist trusts only itself and this Home — a relying-app
    // origin (Gather, Field, …) is rejected and the person is stranded on Commons' door. So the
    // notify bounces back HERE (`fc=1` marks the pass; teardown above is idempotent), and this
    // Home forwards to the relying app itself.
    const notify = params.get('fc') === '1' ? null : commonsFrontChannelLogout();
    if (notify) {
      const back = new URL('/logout', window.location.origin);
      back.searchParams.set('fc', '1');
      const ret = params.get('return');
      if (ret) back.searchParams.set('return', ret);
      const next = new URL(notify);
      next.searchParams.set('return', back.toString());
      window.location.replace(next.toString());
      return;
    }
    window.location.replace(dest);
  }, []);

  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Signing out" />
          <p className="onboarding-busy-msg">Signing you out…</p>
        </div>
      </div>
    </div>
  );
}
