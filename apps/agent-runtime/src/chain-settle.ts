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
