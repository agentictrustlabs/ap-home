'use client';
// THE DECISION, TAKEN WHERE IT WAS READ — spec 364.
//
// "Send bob 1.2 USDC" used to become TWO flows and neither finished. Alice's payment could not resolve
// Bob's unlisted treasury, so it sent him a request and dropped her sentence on the floor; Bob got a
// message with a LINK to another page, went there (or did not), and approved; and then nobody told
// Alice's original intent that it could proceed. Two surfaces, two abandoned halves, one unpaid person.
//
// So the message CARRIES the decision. A `contextRef` is a typed pointer — display and routing metadata,
// never authority (spec 309 §4.2) — and these components render one as the act itself: Bob shares his
// treasury from the thread he read the request in, and Alice finishes her payment from the thread she is
// told in. Nothing is granted by a message: sharing still signs the grant with the credential that
// custodies the issuer, and the payment still needs Alice's mandate. What changed is where the person is
// standing when they decide.
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { signHashFor, resolveVia, type Via } from '../../../home/onboarding';
import { ensureCsrfToken, csrfHeaders } from '../../../csrf';

const chipStyle = {
  border: '1px solid var(--color-sage-500)', background: 'var(--color-sage-50)', color: 'var(--color-sage-700)',
  fontWeight: 600, cursor: 'pointer',
} as const;

/**
 * SHARE A WAY TO REACH ONE OF MINE — the inline half of the `/treasuries` decision.
 *
 * It calls the same two-step ceremony that page calls: the agent builds the grant, the person signs its
 * digest with the credential that custodies them, and the agent verifies that signature on chain before
 * delivering anything. A session says who is logged in; a signature says who decided, and only the
 * second is something the holder can be shown later.
 *
 * WHICH agent gets shared is the person's own answer. When their preference already says (`ap:primaryPayee`
 * — spec 363), there is nothing to ask and the chip is one press; otherwise it offers what they hold.
 */
export function ShareWayChip({ refId, label }: { refId: string; label?: string }) {
  const { session, profile, agentAddress } = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'shared' | 'error'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [choices, setChoices] = useState<Array<{ agent: string; name?: string; primary?: boolean }> | null>(null);
  const [requester = '', wants = 'treasury'] = refId.split('/');

  const share = useCallback(async (target?: string) => {
    if (!session?.token || !agentAddress || !requester) return;
    setState('busy'); setNote(null);
    try {
      await ensureCsrfToken();
      const post = async (payload: unknown) => {
        const res = await fetch('/a2a/resolution/grant', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(payload),
        });
        const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; grant?: Record<string, unknown>; digest?: `0x${string}`; candidates?: Array<{ agent: string; name?: string; primary?: boolean }> };
        if (!b.ok) throw new Error(b.error ?? `the grant was refused (${res.status})`);
        return b;
      };
      let chosen = target;
      if (!chosen) {
        // WHICH ONE OF MINE. Asked once, of the person who is the only one who can answer — and not
        // asked at all when they have already said (a marked primary payee is that answer).
        const res = await fetch(`/a2a/resolution/candidates?wants=${encodeURIComponent(wants)}`, {
          credentials: 'include', headers: { authorization: `Bearer ${session.token}` },
        });
        const b = (await res.json().catch(() => ({}))) as { ok?: boolean; candidates?: Array<{ agent: string; name?: string; primary?: boolean }> };
        const cands = b.candidates ?? [];
        const marked = cands.filter((c) => c.primary);
        if (marked.length === 1) chosen = marked[0]!.agent;
        else if (cands.length === 1) chosen = cands[0]!.agent;
        else { setChoices(cands); setState('idle'); return; }
      }
      const base = { session: session.token, requester, targetAgent: chosen, wants };
      const prepared = await post({ ...base, prepare: true });
      if (!prepared.grant || !prepared.digest) throw new Error('the agent did not return a grant to sign');
      const via = resolveVia(profile?.credential, session.via) as Via;
      const signHash = await signHashFor(via, agentAddress as Address, { token: session.token });
      await post({ ...base, grant: prepared.grant, signature: await signHash(prepared.digest) });
      setState('shared');
    } catch (e) {
      setState('error'); setNote(e instanceof Error ? e.message : String(e));
    }
  }, [session, profile, agentAddress, requester, wants]);

  if (state === 'shared') {
    return <span className="badge" data-testid="share-way-done" style={{ ...chipStyle, cursor: 'default' }}>Shared — they can reach it now</span>;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
      {choices?.length ? (
        <>
          {choices.map((c) => (
            <button key={c.agent} type="button" className="badge" style={chipStyle}
              data-testid={`share-way-pick-${c.agent}`} onClick={() => void share(c.agent)}>
              Share {c.name ?? `${c.agent.slice(0, 6)}…${c.agent.slice(-4)}`}
            </button>
          ))}
        </>
      ) : (
        <button type="button" className="badge" style={chipStyle} disabled={state === 'busy'}
          data-testid="share-way" onClick={() => void share()}>
          {state === 'busy' ? 'Sharing…' : `Share ${label ?? `my ${wants}`}`}
        </button>
      )}
      {/* NOT NOW is a real answer and stays one. Declining writes nothing and revokes nothing: the
          request simply goes unanswered, which is what it means to decide not to disclose an agent. */}
      {choices?.length ? null : (
        <button type="button" className="badge" style={{ ...chipStyle, background: 'transparent', fontWeight: 500 }}
          data-testid="share-way-decline" onClick={() => setNote('Left as it is — nothing was shared.')}>
          Not now
        </button>
      )}
      {note && <span className="muted" style={{ fontSize: 11 }}>{note}</span>}
    </span>
  );
}

/**
 * FINISH WHAT YOU WERE DOING — the other half of the same flow.
 *
 * The person asked to pay somebody they could not reach; the answer arrived as a message. This puts the
 * sentence back in their Ask, with the figure they named, so the intent survives the round trip instead
 * of being retyped from memory. It PREFILLS and does not send: the person still reads it and presses
 * send, and the payment still takes their mandate — the same rule every suggested ask follows.
 */
export function ContinuePaymentChip({ refId, label, names }: { refId: string; label?: string; names?: Record<string, string> }) {
  const [owner = '', usdc = ''] = refId.split('/');
  const who = names?.[owner.toLowerCase()] ?? owner;
  const sentence = `send ${who} ${usdc} usdc`;
  return (
    <button
      type="button" className="badge" style={chipStyle} data-testid="continue-payment"
      onClick={() => window.dispatchEvent(new CustomEvent('ap:ask', { detail: { message: sentence } }))}
      title="Puts it back in your Ask — you still read it and press send"
    >
      Finish sending {label ?? `${usdc} USDC`}
    </button>
  );
}
