// Journey indicator — a row of dots (done / current / future), announced to screen readers.
export function OnboardingProgress({ total, current, label }: { total: number; current: number; label: string }) {
  return (
    <div className="onboarding-progress" role="status" aria-live="polite" aria-label={`Step ${current} of ${total}: ${label}`}>
      {Array.from({ length: total }, (_, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'current' : 'future';
        return <span key={n} className={`progress-dot ${state}`} aria-hidden="true" />;
      })}
    </div>
  );
}
