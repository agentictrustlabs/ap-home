// THE RETRY AFFORDANCE — spec 398 §7.2 (1). A contract's `idempotency` says how many times its act may land for one
// request; a surface offers a retry ONLY where repeating is honest: `replay-safe` (a read) and `one-per-resource-version`
// (an edit) may simply be asked again; `one-per-request` (a charter, a payment, a send) is asked again as a NEW
// request, said so; an `effect-uncertain` run is never retried on a click (T10 — reconcile first). Nothing here is
// authority — the nonce the harness carries is what actually prevents a double landing.
import type { AskVocabularyEntry } from './ask';
import type { ProjectedRunStateV1 } from './run-state';

export type RetryAffordance =
  | { kind: 'retry'; label: string; why: string }
  | { kind: 'new-request'; label: string; why: string }
  | { kind: 'none'; why: string };

export function retryAffordance(state: ProjectedRunStateV1, capability: string | undefined, vocabulary: ReadonlyArray<AskVocabularyEntry>): RetryAffordance {
  if (state.effectUncertain) return { kind: 'none', why: 'the effect may have happened — reconcile before asking again' };
  if (state.state !== 'failed' && state.state !== 'canceled' && state.state !== 'expired') return { kind: 'none', why: 'the run is not over' };
  const entry = capability ? vocabulary.find((v) => v.id === capability) : undefined;
  switch (entry?.idempotency) {
    case 'replay-safe': return { kind: 'retry', label: 'Ask again', why: 'a read — repeating it is harmless' };
    case 'one-per-resource-version': return { kind: 'retry', label: 'Ask again', why: 'an edit — repeating it against an unchanged record is a no-op' };
    case 'one-per-request': return { kind: 'new-request', label: 'Ask again as a new request', why: 'this act lands once per request; a repeat is a new request with its own nonce and mandate' };
    default: return { kind: 'none', why: capability ? 'this capability declares no idempotency — no retry is offered' : 'no acted step to repeat' };
  }
}
