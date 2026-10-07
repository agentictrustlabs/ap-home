'use client';
// Shared wait state for Home ceremonies (org-create, site-login grant). A single spinner
// with no progress lied about a 15–40s on-chain deploy. This names the current step and
// shows how far through the ceremony we are.
//
// `total <= 0` means "not known yet" and shows NO counter. The total belongs to the ceremony that is
// running (org-create says 5, select-existing 3, the plain sign-in 3), and before that ceremony has
// spoken the screen used to show a made-up "Step 1 of 3" placeholder — so a five-step org-create read
// "Step 1 of 3" → "Step 2 of 5". A counter that changes its denominator is worse than none.

export function CeremonyProgress({
  label,
  hint,
  step,
  total,
}: {
  label: string;
  hint?: string;
  step: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((Math.max(step, 1) / total) * 100)) : 0;
  return (
    <div className="onboarding-busy" role="status" aria-live="polite">
      <span className="spinner spinner-lg" aria-hidden="true" />
      <p className="onboarding-busy-msg">{label}</p>
      {hint && <p className="onboarding-busy-sub">{hint}</p>}
      {total > 0 && (
        <>
          <div className="ceremony-progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="ceremony-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="onboarding-busy-sub">
            Step {Math.min(step, total)} of {total}
          </p>
        </>
      )}
    </div>
  );
}
