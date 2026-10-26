// A SIGNATURE APPROVED A MOMENT AGO — the approved-hash sentinel (0x03) is true on chain only once the person's
// approve-hash userOp has landed, and the read that checks it may reach a node that has not seen that block yet (found
// live, 2026-10-26: `/harness/authorize` submit answered, the next `/harness/ask` read "delegation signature did not
// verify", about one act in three — a remove, an accept, an add). A sentinel that does not verify is read again for a
// few seconds before it is refused; any other signature is answered by its first read (a key signature does not
// become valid later, so waiting would only delay a refusal).
import type { Hex } from 'viem';

export const APPROVED_HASH_SENTINEL = '0x03';
export const SETTLE_TRIES = 5;
export const SETTLE_EVERY_MS = 1500;

export async function verifyAllowingSettle(
  read: () => Promise<boolean>,
  signature: Hex | string,
  opts: { tries?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  if (await read().catch(() => false)) return true;
  if (String(signature).toLowerCase() !== APPROVED_HASH_SENTINEL) return false;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; i < (opts.tries ?? SETTLE_TRIES); i++) {
    await sleep(opts.everyMs ?? SETTLE_EVERY_MS);
    if (await read().catch(() => false)) return true;
  }
  return false;
}

/**
 * A USEROP THAT IS NOT IN ITS RECEIPT MAY NOT HAVE RUN AT ALL (found live, 2026-10-26). The relayer key is shared, so a
 * handleOps send can be replaced by another path's transaction with the same nonce; the receipt handed back then holds
 * no UserOperationEvent of ours — and the approval it carried never ran (the next ask read "delegation signature did
 * not verify", and kept reading it: waiting does not land an op that was dropped). The account's own nonce says which:
 * unmoved ⇒ it did not run, and the same signed op (still valid — its nonce is the account's) is sent again; moved ⇒
 * it ran in some other transaction, and that is success.
 */
export interface Judged { ok: boolean; matched?: boolean }
export async function submitUntilRun<R>(input: {
  submit: () => Promise<R>;
  judge: (receipt: R) => Judged;
  /** The account's nonce for the op's key, read now. */
  nonceNow: () => Promise<bigint>;
  opNonce: bigint;
  tries?: number;
}): Promise<{ receipt: R | null; inner: Judged; ran: 'here' | 'elsewhere' | 'not-run'; attempts: number; error?: string }> {
  const tries = input.tries ?? 3;
  // A send that THROWS (the shared relayer's nonce taken under it: "nonce too low", a replaced transaction) is the
  // same unknown as a receipt without our op — the nonce decides — never a bare 500 to the person.
  let error: string | undefined;
  const send = async (): Promise<{ receipt: R | null; inner: Judged }> => {
    try { const r = await input.submit(); return { receipt: r, inner: input.judge(r) }; }
    catch (e) { error = e instanceof Error ? e.message : String(e); return { receipt: null, inner: { ok: false, matched: false } }; }
  };
  let { receipt, inner } = await send();
  for (let attempt = 1; ; attempt++) {
    if (inner.ok || inner.matched !== false) return { receipt, inner, ran: 'here', attempts: attempt };
    const now = await input.nonceNow().catch(() => null);
    if (now !== null && now > input.opNonce) return { receipt, inner, ran: 'elsewhere', attempts: attempt };
    if (attempt >= tries) return { receipt, inner, ran: 'not-run', attempts: attempt, ...(error ? { error } : {}) };
    ({ receipt, inner } = await send());
  }
}
