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
import { SectionShell } from './SectionShell';
import { AddressChip } from '../shared/AddressChip';
import { cardSty, mutedText, errorText } from './theme';

interface SentRequest { kind?: string; owner?: string; ownerName?: string; wants?: string; amount?: string; status?: string }
interface HeldGrant { targetAgent?: string; owner?: string; ownerName?: string; targetType?: string; expiresAt?: string }

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
      return { grant, ...(mine?.amount ? { amount: mine.amount } : {}) };
    }));
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  if (!session || !rows?.length) return null;

  return (
    <SectionShell title="Ready to send">
      {err && <p style={errorText}>{err}</p>}
      {rows.map(({ grant, amount }) => (
        <div key={grant.targetAgent} style={cardSty} data-testid={`ready-to-send-${(grant.owner ?? '').toLowerCase()}`}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {grant.ownerName ?? 'They'} gave you a way to reach their {grant.targetType}
          </div>
          <div style={{ marginTop: 4 }}><AddressChip address={grant.targetAgent ?? ''} /></div>
          <p style={{ ...mutedText, fontSize: 11.5, margin: '6px 0 0', lineHeight: 1.5 }}>
            {amount
              ? `You were sending ${amount} USDC. Finish it below — you will still authorize the payment itself.`
              : 'You can send there now. You will still authorize the payment itself.'}
          </p>
          <button
            type="button" className="btn primary" style={{ marginTop: 10, fontSize: 12 }}
            data-testid={`ready-to-send-go-${(grant.owner ?? '').toLowerCase()}`}
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
    </SectionShell>
  );
}
