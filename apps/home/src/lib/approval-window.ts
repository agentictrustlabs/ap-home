// A FOCUSED APPROVAL WINDOW FINISHES BY ITSELF. Home's approval pages for apps (/household-setup,
// /organization-invitation, /enable-messaging) open as a small window from the app. When the approval is done the
// page tells the app (a hint: the app still confirms by reading) and CLOSES ITSELF, so the person is not left with a
// stray Home window over the app. A browser may refuse `window.close()` (a window the script did not open, or a tab
// the person navigated): then the page says "You can close this window" instead of pretending it closed.
//
// Pure over the window it is given, so it is tested without a browser.
export interface ApprovalWindow {
  opener: { postMessage(message: unknown, targetOrigin: string): void; closed?: boolean } | null;
  close(): void;
  readonly closed: boolean;
}
export interface FinishOptions {
  /** The app's origin: the only origin told the outcome. */
  targetOrigin: string;
  message: Record<string, unknown>;
  /** How long the "done" state shows before the window closes. */
  delayMs?: number;
  /** Called when the window is still open after asking it to close: show "You can close this window". */
  onStillOpen: () => void;
  /** Tests pass a synchronous scheduler. */
  schedule?: (run: () => void, ms: number) => unknown;
}
/**
 * Tell the opener, then close. Returns `false` when there is no opener to go back to (the page was opened as a tab):
 * the caller keeps its own "Back to the app" link and nothing is closed.
 */
export function finishApprovalWindow(win: ApprovalWindow, o: FinishOptions): boolean {
  const opener = win.opener && !win.opener.closed ? win.opener : null;
  if (!opener) return false;
  try {
    opener.postMessage(o.message, o.targetOrigin);
  } catch {
    // a refused message is only a lost hint: the app reads the outcome anyway
  }
  const schedule = o.schedule ?? ((run, ms) => setTimeout(run, ms));
  schedule(() => {
    try { win.close(); } catch { /* refused: said below */ }
    // close() is asynchronous in some browsers: look again a moment later
    schedule(() => { if (!win.closed) o.onStillOpen(); }, 300);
  }, o.delayMs ?? 900);
  return true;
}
