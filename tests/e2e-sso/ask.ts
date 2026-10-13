import { expect, type Page } from '@playwright/test';

/**
 * Drive an Ask run to the end, answering every prompt it raises.
 *
 * A turn is not fast and its length is not knowable in advance: a payment re-runs every gate, reads
 * the chain, and — since the resolver gate — calls the resolver per candidate. So this waits for the
 * run to SAY something (a prompt, or the busy line going away) rather than sleeping a fixed interval
 * and guessing that silence means "finished". The old sleep-then-check loop broke out of the FIRST
 * turn that took longer than its nap and left a signature obligation unanswered, which reads exactly
 * like a payment that silently failed.
 */
export async function settleAsk(page: Page, opts: { timeout?: number; answer?: () => Promise<void> } = {}): Promise<'settled' | 'timeout'> {
  const deadline = Date.now() + (opts.timeout ?? 420_000);
  // A run that has not started yet looks exactly like one that has finished: nothing is pending and the
  // box takes typing. Wait for it to be underway before deciding it is over. Absent ⇒ it already finished
  // (a fast turn, or a caller that waited first), which is fine — that is why this does not fail.
  await page.getByTestId('ask-input').isDisabled().catch(() => false)
    || await expect(page.getByTestId('ask-input')).toBeDisabled({ timeout: 15_000 }).catch(() => undefined);
  while (Date.now() < deadline) {
    const prompt = page.getByTestId('ask-prompt');
    if (await prompt.isVisible().catch(() => false)) {
      if (opts.answer) await opts.answer();
      else await page.getByTestId('ask-answer').click();
      // One click per prompt: the card stays up while the answer is signed and posted, and clicking
      // it twice would answer the NEXT prompt with the last one's input.
      await expect(prompt).toBeHidden({ timeout: 120_000 });
      continue;
    }
    // Settled is a property of the surface, not of a spinner: the ask box takes typing again only
    // when nothing is running and no card is waiting on you.
    if (await page.getByTestId('ask-input').isEnabled().catch(() => false)) return 'settled';
    await page.waitForTimeout(2_000);
  }
  return 'timeout';
}
