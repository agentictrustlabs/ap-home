// THE RUN'S OWN BILL — spec 396 W3 (the priorities doc's G3). Every InteractionsDO op already reports what it cost
// on its response headers (spec 396 W1); a harness run makes many such calls — the planner's reads, each step's
// invoker, the record and provenance writes. This is the request-scoped ledger they add up in (AsyncLocalStorage:
// concurrent runs never share one), attributed to the step that was running (the invoker names it) or to `plan`.
// It lands on the run record (`RunRecordV1.bill`) and is exported as the `ap.vault.calls` metric (390). Numbers,
// never content; nothing here decides anything.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RunBillV1 } from '@agenticprimitives/orchestration';

interface BillStore extends RunBillV1 { current?: string }
const store = new AsyncLocalStorage<BillStore>();

export const newBill = (): RunBillV1 => ({ vaultCalls: 0, doRequests: 0, byStep: {} });

/** Run `fn` under a fresh bill; returns the bill beside the result. */
export async function billed<T>(fn: () => Promise<T>): Promise<{ result: T; bill: RunBillV1 }> {
  const bill: BillStore = newBill();
  const result = await store.run(bill, fn);
  const { current: _c, ...rest } = bill;
  return { result, bill: rest };
}

/** The invoker names the step it is running; DO calls until the next step charge to it. */
export function setBillStep(stepRef: string | undefined): void {
  const s = store.getStore();
  if (s) s.current = stepRef;
}

/** Charge one DO response to the current bill (the op's cost headers, spec 396 W1). No store ⇒ nothing counted. */
export function chargeBill(headers: Headers): void {
  const s = store.getStore();
  if (!s) return;
  const calls = Number(headers.get('x-ap-vault-calls') ?? 0) || 0;
  const key = s.current ?? 'plan';
  s.doRequests += 1;
  s.vaultCalls += calls;
  const step = s.byStep[key] ?? { vaultCalls: 0, doRequests: 0 };
  step.doRequests += 1; step.vaultCalls += calls;
  s.byStep[key] = step;
}
