'use client';
// Shared wait state for Home ceremonies (org-create, site-login grant). A single spinner
// with no progress lied about a 15–40s on-chain deploy. This names the current step and
// shows how far through the ceremony we are.

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
      <div className="ceremony-progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="ceremony-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="onboarding-busy-sub">
        Step {Math.min(step, total)} of {total}
      </p>
    </div>
  );
}
