'use client';
// THE APPROVE-TO-SEND AFFORDANCE (spec 341 §5.1b).
//
// One component because a blocked send happens on five surfaces and the remedy is identical on all of
// them. Rendering it as an ACTION rather than an error is the point: "delivery rejected" is accurate
// and useless when the fix is a single signature the person is entitled to make.
//
// IT IS SHOWN ONLY FOR THE TWO RESOLVABLE CASES. A revoked wire, a recipient who never enabled
// delivery, a gate rejection — none of those are fixed by signing again, and offering to sign for them
// would be a loop the person cannot escape. `MessagingWireRequiredError` is thrown for exactly the two
// cases that ARE fixable, which is why it exists as a distinct type.

import { useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { BusyButton } from '../shared/BusyButton';
import { approveMessagingContact } from '../../lib/messaging-ceremony';
import { resolveVia } from '../../home/onboarding';
import type { MessagingWireRequiredError } from '../../lib/messaging-send';

export function ApproveMessaging({
  need,
  person,
  session,
  credential,
  onApproved,
  onError,
}: {
  /** Null hides the banner entirely — the caller clears it after a successful send. */
  need: MessagingWireRequiredError | null;
  person: Address | null;
  session: { token: string; via?: string } | null;
  /** `profile.credential` — what routes the signature to passkey / wallet / KMS. */
  credential?: string;
  onApproved: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!need || !person || !session) return null;
  return (
    <div className="chat-attention" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '0.85rem' }}>
        {need.reason === 'wire_absent'
          ? 'Approve your agent to send messages for you — one signature, and you can revoke it anytime.'
          : 'You haven’t approved messaging this contact yet — one signature adds them.'}
      </span>
      <BusyButton
        busy={busy}
        busyLabel="Signing…"
        onClick={async () => {
          setBusy(true);
          try {
            await approveMessagingContact({
              person,
              // No recipient means there is no wire at all. The agent reports the counterparty that
              // was blocked whenever it knows one, so the union starts from the right place.
              recipient: (need.recipient ?? person) as Address,
              via: resolveVia(credential, session.via),
              token: session.token,
            });
            onApproved();
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Approve
      </BusyButton>
    </div>
  );
}
