'use client';
// Full SSO sign-out (spec 264 / ADR-0032 follow-up). A relying app sends the member here
// (`/logout?return=<rp-url>`) when they disconnect: we END the impact home session — clear the
// cross-subdomain `ap_sso` cookie + this origin's stored session — and signal FedCM logged-out so it
// won't auto-recognize the member on the next connect, then bounce back to the relying app.
//
// A TOP-LEVEL navigation (not a hidden iframe) is deliberate: `navigator.login.setStatus` and the cookie
// clear must apply to the IdP origin itself, and Chrome restricts `setStatus` from cross-site iframes.
// Same reason relying apps are notified with a top-level GET: their session cookies/storage are
// first-party only, so a hidden iframe from this origin would not reach them. Front-channel logout
// is a navigation — the `fc` param walks the relying-app list (teardown above is idempotent).
import { useEffect } from 'react';
import { clearSsoCookie } from '../../src/lib/sso-cookie';
import { setFedcmLoginStatus, SESSION_KEY } from '../../src/context/session';
import { getClient, isAllowedRelyingOrigin } from '../../src/lib/oidc-clients';
import { disconnectWallet } from '../../src/lib/wallet';

/** Relying apps that receive a front-channel sign-out at their `/sso-logout` — each clears its
 *  own origin (and, via a storage marker, its other open tabs) and bounces back here. https from
 *  prod, loopback from local — same filtering the Commons-only version applied. */
function rpFrontChannelLogouts(): string[] {
  const hereHttps = window.location.protocol === 'https:';
  const outs: string[] = [];
  const rpApps = (process.env.NEXT_PUBLIC_LOGOUT_RP_APPS ?? 'commons-app,field-app')
    .split(',').map((x) => x.trim()).filter(Boolean);
  for (const id of rpApps) {
    const client = getClient(id);
    if (!client) continue;
    for (const uri of client.redirect_uris) {
      try {
        const u = new URL(uri);
        if (hereHttps && u.protocol !== 'https:') continue;
        if (!hereHttps && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') continue;
        outs.push(new URL('/sso-logout', u.origin).toString());
        break;
      } catch {
        /* skip a malformed registered URI */
      }
    }
  }
  return outs;
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

    // Relying apps' /sso-logout return-allowlists trust only themselves and this Home — a foreign
    // relying-app origin would strand the person. So every notify bounces back HERE (`fc` names
    // the next index; teardown above is idempotent), and this Home forwards along the list, then
    // finally to the original return.
    const rps = rpFrontChannelLogouts();
    const idx = Number(params.get('fc') ?? '0') || 0;
    void (async () => {
      for (let i = idx; i < rps.length; i++) {
        const notify = rps[i]!;
        // LOCAL stacks: a dev port may simply not be running, and a top-level navigation to a
        // dead origin strands the person on a browser error page — AFTER the teardown above
        // already finished, so the "error" is pure UX damage. Probe reachability first (no-cors —
        // any response, even opaque, proves something is listening) and skip the notify when
        // nothing answers. Production (https) navigates unconditionally, as before.
        let reachable = true;
        if (window.location.protocol !== 'https:') {
          const ctl = new AbortController();
          const t = window.setTimeout(() => ctl.abort(), 1200);
          reachable = await fetch(new URL(notify).origin + '/', { mode: 'no-cors', signal: ctl.signal })
            .then(() => true)
            .catch(() => false);
          window.clearTimeout(t);
        }
        if (!reachable) continue;
        const back = new URL('/logout', window.location.origin);
        back.searchParams.set('fc', String(i + 1));
        const ret = params.get('return');
        if (ret) back.searchParams.set('return', ret);
        const next = new URL(notify);
        next.searchParams.set('return', back.toString());
        window.location.replace(next.toString());
        return;
      }
      window.location.replace(dest);
    })();
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
