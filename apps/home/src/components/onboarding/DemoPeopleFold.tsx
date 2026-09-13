'use client';
// DEV-ONLY: a hidden "Demo people" fold on the Home's own front entry (localhost stacks only) —
// the same walkthrough affordance the relying apps carry, for the Home itself. Picking a persona
// mints their homeSession via the existing /connect/demo-signin seam and adopts it through
// openSession — the exact rail the SIWE handoff already rides. Renders nothing off localhost.
import { useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { WorkingBar } from './WorkingBar';

interface DemoPersona { readonly handle: string; readonly name: string }

export function DemoPeopleFold({ enroll, appName, onSession }: {
  /** Spec 397 — on a relying app's ENROLL screen (the Home MCP's, say): picking a persona signs them in and hands the
   *  session to the enroll flow, which then authorizes the app as them (the recognized path, prompt-free for a demo person). */
  enroll?: boolean;
  appName?: string;
  onSession?: (token: string, via: string) => Promise<void>;
} = {}) {
  const { openSession } = useSession();
  const [personas, setPersonas] = useState<readonly DemoPersona[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Localhost always; or any deployment that opts in via NEXT_PUBLIC_ENABLE_DEMO_PEOPLE=true
  // (the faithnet pilot Home shows demo people; production leaves it unset and stays clean).
  const local =
    (typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname)) ||
    process.env.NEXT_PUBLIC_ENABLE_DEMO_PEOPLE === 'true';
  useEffect(() => {
    if (!local) return;
    void fetch('/connect/demo-personas')
      .then((r) => r.json())
      .then((d: { personas?: DemoPersona[] }) => setPersonas(d.personas ?? []))
      .catch(() => setPersonas([]));
  }, [local]);
  if (!local || personas === null || personas.length === 0) return null;
  return (
    <details className="demo-people-fold" style={{ margin: '1.2rem auto 0', maxWidth: 420, width: '100%', fontSize: '.8rem', color: 'var(--color-text-muted, #475569)', textAlign: 'left' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.78rem', fontWeight: 500 }}>
        <span aria-hidden className="demo-people-fold__chev" style={{ display: 'inline-block', transition: 'transform .15s' }}>›</span> Demo people
      </summary>
      <p style={{ margin: '.5rem 0' }}>
        {enroll
          ? `Walkthrough only — each is a real Home this stack seeded. Pick one to continue to ${appName ?? 'the app'} as them; they authorize it on the next screen.`
          : 'Local walkthrough only — each is a real Home this stack seeded. Signing in as one opens THEIR portal session on this browser.'}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {personas.map((p) => (
          <button
            key={p.handle}
            type="button"
            className="btn-ghost onboarding-secondary"
            style={{ width: 'auto', padding: '.3rem .7rem', fontSize: '.78rem', fontWeight: 500 }}
            disabled={busy !== null}
            onClick={() => {
              setBusy(p.handle);
              setErr(null);
              void fetch('/connect/demo-signin', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ handle: p.handle, client_id: 'demo-web' }),
              })
                .then((r) => r.json())
                .then(async (d: { ok?: boolean; homeSession?: string; error?: string }) => {
                  if (!d.ok || !d.homeSession) throw new Error(d.error ?? 'demo sign-in failed');
                  if (onSession) await onSession(d.homeSession, 'Wallet');
                  else await openSession(d.homeSession, 'Wallet', true);
                })
                .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'demo sign-in failed'))
                .finally(() => setBusy(null));
            }}
          >
            {busy === p.handle ? 'Connecting…' : p.name.split(' — ')[0]}
          </button>
        ))}
      </div>
      {busy && <WorkingBar label={`Opening ${personas.find((p) => p.handle === busy)?.name.split(' — ')[0] ?? 'their'} home…`} />}
      {err && <p style={{ color: '#b91c1c', marginTop: '.4rem' }}>{err}</p>}
    </details>
  );
}
