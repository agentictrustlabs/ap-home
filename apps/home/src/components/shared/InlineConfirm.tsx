'use client';
// Inline confirmation for contained destructive actions (revoke, remove device) — replaces
// browser confirm()/modals. Parent controls when it's shown.
export function InlineConfirm({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  dangerous = false,
  busy = false,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  dangerous?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="inline-confirm" role="alertdialog" aria-label={title}>
      <div className="inline-confirm-title">{title}</div>
      <p className="inline-confirm-body">{body}</p>
      <div className="inline-confirm-actions">
        <button type="button" className={dangerous ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
