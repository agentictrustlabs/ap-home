// Onboarding overview — the value milestones (NOT a wizard progress bar). Circles fill as
// steps complete. Presentational; copy comes from props.
export interface ValueStep {
  id: string;
  title: string;
  body: string;
  status: 'pending' | 'active' | 'done';
}

export function ValueStepList({ steps }: { steps: ValueStep[] }) {
  return (
    <ol className="value-step-list">
      {steps.map((s, i) => (
        <li key={s.id} className={`value-step ${s.status}`}>
          <span className="value-step-n" aria-hidden="true">{s.status === 'done' ? '✓' : i + 1}</span>
          <div>
            <div className="value-step-title">{s.title}</div>
            <div className="value-step-body">{s.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
