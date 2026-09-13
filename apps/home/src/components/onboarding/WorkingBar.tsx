'use client';
// A moving bar for any onboarding beat that is WORKING — securing a home, signing a grant, returning to an
// app. Motion is the whole point: a screen that says "Returning you to Poker Night…" and sits still reads as
// frozen; the bar says the page is alive and something is happening on its behalf. Pair it with the words that
// say WHAT is happening; it never replaces them.
export function WorkingBar({ label }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" style={{ width: '100%' }}>
      <div className="onboarding-working" aria-hidden />
      {label && <p className="onboarding-working-label">{label}</p>}
    </div>
  );
}
