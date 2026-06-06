'use client';
// Full SSO sign-out (spec 264 / ADR-0032 follow-up). A relying app sends the member here
// (`/logout?return=<rp-url>`) when they disconnect: we END the impact home session — clear the
// cross-subdomain `ap_sso` cookie + this origin's stored session — and signal FedCM logged-out so it
// won't auto-recognize the member on the next connect, then bounce back to the relying app.
//
// A TOP-LEVEL navigation (not a hidden iframe) is deliberate: `navigator.login.setStatus` and the cookie
// clear must apply to the IdP origin itself, and Chrome restricts `setStatus` from cross-site iframes.
// The relying app redirects here on Disconnect; this page is the only place the SSO session is torn down.
import { useEffect } from 'react';
import { clearSsoCookie } from '../../src/lib/sso-cookie';
import { setFedcmLoginStatus, SESSION_KEY } from '../../src/context/session';
import { isAllowedRelyingOrigin } from '../../src/lib/oidc-clients';

export default function LogoutPage() {
  useEffect(() => {
    try {
      localStorage.removeItem(SESSION_KEY); // this origin's persisted session
    } catch {
      /* storage blocked — fine */
    }
    clearSsoCookie(); // end the cross-subdomain `.impact-agent.me` SSO session
    setFedcmLoginStatus('logged-out'); // FedCM: don't auto-recognize / show the chooser next time

    // Anti open-redirect: only bounce back to a REGISTERED relying-app origin; otherwise the apex.
    let dest = '/';
    try {
      const ret = new URL(window.location.href).searchParams.get('return');
      if (ret && isAllowedRelyingOrigin(ret)) dest = ret;
    } catch {
      /* malformed return — fall back to apex */
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
