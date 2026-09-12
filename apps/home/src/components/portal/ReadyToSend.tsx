// SOMEONE ANSWERED — spec 338 §7, the half that finishes the thing you started.
//
// You tried to pay someone, it could not be routed, you asked them for a way, and days later a grant
// arrives in your vault. On its own that is an address with no story: nothing in your Home says it is the
// thing you were trying to pay, or how much. This card joins the two — the request YOU sent and the grant
// THEY gave — and offers the one press that finishes it.
//
// The button prefills the ask; it does not send money. Everything that follows is the ordinary path: the
// mandate you sign, the approval a payment's risk demands, the receipt. A grant told you where to send,
// and where is not whether.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { Section, Empty, ErrorNote } from '../../ui';
import { AddressChip } from '../shared/AddressChip';
import { cardSty, mutedText } from './theme';

interface SentRequest { kind?: string; owner?: string; ownerName?: string; wants?: string; amount?: string; status?: string }
/** A REFERENCE, not an address. The holder is told whose agent they may reach and which grant says so;
 *  where it is comes from the resolver, per use (spec 338 §4) — so this surface cannot show it either,
 *  and should not pretend to. */
interface HeldGrant { grantId?: string; owner?: string; ownerName?: string; targetType?: string; expiresAt?: string }

/** What the composed ask should say, in the person's own voice. */
export function completionAsk(g: HeldGrant, amount?: string): string {
  const who = g.ownerName ?? g.owner ?? 'them';
  return amount ? `send ${amount} usdc to ${who}` : `send money to ${who}`;
}

export function ReadyToSend({ onAsk }: { onAsk?: (message: string) => void }) {
  const { session } = useSession();
  const token = session?.token;
  const [rows, setRows] = useState<Array<{ grant: HeldGrant; amount?: string }> | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    const auth = { authorization: `Bearer ${token}` };
    const [gRes, rRes] = await Promise.all([
      fetch('/a2a/resolution/grants', { headers: auth }),
      fetch('/a2a/resolution/requests', { headers: auth }),
    ]);
    const g = (await gRes.json().catch(() => ({}))) as { ok?: boolean; grants?: HeldGrant[]; error?: string };
    const r = (await rRes.json().catch(() => ({}))) as { requests?: SentRequest[] };
    if (g.ok === false) { setErr(g.error ?? 'could not read what you have been given'); setRows([]); return; }
    // EVERY grant you hold, with the amount attached when one of your own asks explains it. The first
    // version showed only grants it could match to a request and rendered nothing when the match failed —
    // so a real grant, sitting in the vault, was invisible because a second record did not line up. The
    // amount is an enrichment; the grant is the fact.
    const sent = (r.requests ?? []).filter((x) => x.kind === 'resolution.invitation.sent');
    setRows((g.grants ?? []).map((grant) => {
      const mine = sent.find((x) => (x.owner ?? '').toLowerCase() === (grant.owner ?? '').toLowerCase() && x.wants === grant.targetType);
      const settled = (mine?.status ?? 'pending') !== 'pending';
      return { grant, ...(mine?.amount ? { amount: mine.amount } : {}), settled };
    // WHAT IS STILL WAITING ON YOU. Once the payment that note was for has settled, nothing is — so the
    // card goes. The GRANT is untouched and still usable: this list is a set of open tasks, not an address
    // book, and you can send there by name whenever you like.
    //
    // "Done" is said where the thing was done — the Ask says it, with the transaction. An earlier cut kept
    // the card up one last time showing "Sent", which needed the component to remember what had been open
    // when it mounted; opening the Ask remounts it, so it remembered nothing and the card vanished anyway.
    // Feedback that depends on a component surviving an interaction is feedback that will not be there.
    }).filter((row) => !row.settled));
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  // The task is usually finished in the Ask flyout beside this list, so the card has to hear about it.
  // Without this it keeps saying "finish it below" until the page is reloaded.
  useEffect(() => {
    const onDone = () => { void load(); };
    window.addEventListener('ap:ask-done', onDone);
    return () => window.removeEventListener('ap:ask-done', onDone);
  }, [load]);

  if (!session) return null;
  // Rendered even when empty, quietly. "Nobody has given you a way to reach anything" is a real state and
  // an invisible component is indistinguishable from a broken one — which cost an afternoon establishing
  // whether this had deployed at all.
  if (!rows?.length) {
    return (
      <Section title="Ready to send">
        {err && <ErrorNote>{err}</ErrorNote>}
        <Empty testId="ready-to-send-empty">Nothing waiting. When someone gives you a way to reach an agent of theirs, it appears here.</Empty>
      </Section>
    );
  }

  return (
    <Section title="Ready to send" count={rows.length}>
      {err && <ErrorNote>{err}</ErrorNote>}
      {rows.map(({ grant, amount }) => (
        <div
          key={grant.grantId} style={cardSty}
          data-testid={`ready-to-send-${(grant.grantId ?? '').toLowerCase()}`}
          data-owner={(grant.owner ?? '').toLowerCase()}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {grant.ownerName ?? 'They'} gave you a way to reach their {grant.targetType}
          </div>
          {/* No address, deliberately: you hold a way IN, not a location. It is looked up when you send,
              and it stops being looked up if they withdraw it. */}
          <div style={{ marginTop: 4 }}><AddressChip address={grant.owner ?? ''} /></div>
          <p style={{ ...mutedText, fontSize: 11.5, margin: '6px 0 0', lineHeight: 1.5 }}>
            {amount
              ? `You were sending ${amount} USDC. Finish it below — you will still authorize the payment itself.`
              : 'You can send there now. You will still authorize the payment itself.'}
          </p>
          <button
            type="button" className="btn primary" style={{ marginTop: 10, fontSize: 12 }}
            data-testid={`ready-to-send-go-${(grant.grantId ?? '').toLowerCase()}`}
            onClick={() => {
              const message = completionAsk(grant, amount);
              if (onAsk) onAsk(message);
              else window.dispatchEvent(new CustomEvent('ap:ask', { detail: { message } }));
            }}
          >
            {amount ? `Send ${amount} USDC` : 'Send to it'}
          </button>
        </div>
      ))}
    </Section>
  );
}
