'use client';
// Relying-app session plant. Commons (and any other RP) mints a Home session server-side, then
// sends the browser here with `#session=&return=` so this origin can write `ap_sso`. The
// SessionProvider consumes the fragment and bounces to `return` when it is a registered origin.
//
// Outside the portal on purpose: the portal gate would render the dashboard if the bounce lagged.
import { SessionProvider } from '../../src/context/session';

function HandoffBody() {
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">
        <div className="onboarding-busy">
          <span className="spinner spinner-lg" role="status" aria-label="Signing in" />
          <p className="onboarding-busy-msg">Signing you in…</p>
        </div>
      </div>
    </div>
  );
}

export default function HandoffPage() {
  return (
    <SessionProvider>
      <HandoffBody />
    </SessionProvider>
  );
}
