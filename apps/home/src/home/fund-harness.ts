// THE FUND BUTTON'S GOVERNED CORE, through the harness — spec 361 I4, second family.
//
// The legacy path built the mint userOp in the browser and submitted it directly: one signature, and an
// implementation the Ask could not reach. This path costs the SAME one signature (the mandate) and
// converges on the harness's fund invoker — so the button, the words "fund my treasury with 20 usdc",
// and the receipts they leave are one implementation. What the button GAINS by converging: the spec-360
// FundingReceipt effect fires (the funder's playbook declares it), where the direct mint left no record
// anywhere but the chain.
import type { Address } from '@agenticprimitives/types';
import { mintMandate, type AskReply } from './ask';
import type { SignHash } from './resolution';
import { ensureCsrfToken, csrfHeaders } from '../csrf';

const j = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>;

async function askTurn(body: Record<string, unknown>): Promise<{ reply?: AskReply; error?: string }> {
  await ensureCsrfToken();
  const res = await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  return (await j(res)) as { reply?: AskReply; error?: string };
}

export async function fundThroughHarness(input: {
  treasury: Address;
  /** How much, in the token's SMALLEST units. Atomic rather than a decimal figure because this rail
   *  is no longer USDC-only: a coin's decimals are the app's to declare (`new_member.currency`), and
   *  a float times 10^n is exactly how an amount stops being the amount. The harness takes `amount`
   *  in smallest units for the same reason. */
  amount: bigint;
  /** WHICH token to mint. Omit for the deployment's demo USDC — the harness defaults it, so the
   *  portal's Fund button keeps behaving byte-for-byte as it did. An app that declares its own coin
   *  passes that coin's address here. */
  asset?: Address;
  /** How the amount is SAID, for the sentence the receipt carries ("20 usdc", "10,000 Sheqels"). The
   *  words only; the authority and the effect come from the plan above it. */
  display: string;
  session: { token: string };
  signHash: SignHash;
}): Promise<{ ok: true; txHash?: string } | { ok: false; error: string }> {
  const { treasury, amount, asset, display, session, signHash } = input;
  if (!(amount > 0n)) return { ok: false, error: 'Enter an amount greater than 0.' };
  const plan = {
    steps: [{
      toolId: 'treasury.fund',
      args: {
        treasury: treasury.toLowerCase(),
        amount: amount.toString(),
        ...(asset ? { asset: asset.toLowerCase() } : {}),
      },
    }],
  };
  const message = `fund ${treasury.toLowerCase()} with ${display}`;

  const t1 = await askTurn({ session: session.token, addressee: treasury.toLowerCase(), message, plan });
  const rep = t1.reply;
  if (rep?.kind !== 'authority_required') {
    return { ok: false, error: t1.error ?? `expected an authority request, got ${rep?.kind ?? 'nothing'}` };
  }
  // THE prompt — the mandate. Fund names no second digest, so the plain mint is the one-prompt path.
  const wire = await mintMandate(rep, signHash);
  const t2 = await askTurn({ session: session.token, addressee: treasury.toLowerCase(), runRef: rep.runRef, presented: wire });
  const rep2 = t2.reply;
  if (rep2?.kind !== 'done' && rep2?.kind !== 'answer') {
    return { ok: false, error: t2.error ?? (rep2?.kind === 'refused' ? rep2.error : `unexpected reply ${rep2?.kind ?? 'nothing'}`) };
  }
  const r = (rep2.kind === 'done' ? rep2.result : null) as { txHash?: string } | null;
  return { ok: true, ...(r?.txHash ? { txHash: r.txHash } : {}) };
}
