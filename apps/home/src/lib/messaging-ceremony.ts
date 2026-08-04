// THE MESSAGING CEREMONY — the one prompt that lets a person's agent send on their behalf.
//
// It exists as its own module because it is the ONLY place that joins two things which must not be
// joined anywhere else: the person's custody credential (`signHashFor`, which reaches a passkey, a
// wallet, or a KMS key) and the agent that will spend what it signs. Everything downstream — the
// composer, the invite panel, the reply box — knows only that a send either worked or asked for
// approval; none of them touches a signer.
//
// WHAT THE PERSON IS ACTUALLY APPROVING, and it is worth being precise because "let my agent message
// people for me" is a standing authority: a delegation from them to this deployment's interactions
// session key, naming three messaging skills, pinned to an explicit list of counterparties, valid for
// twelve hours, revocable on-chain at any moment. It does not let the agent read their mail, spend
// anything, or speak to anyone not on the list.
//
// ONE PROMPT PER NEW COUNTERPARTY, never per message (spec 341 §5.1). Adding a contact re-mints over
// the UNION of the existing targets and the new one — see `approveMessagingRecipient` for why a
// narrower mint would silently break sending to everyone already approved.

import type { Address } from '@agenticprimitives/types';
import { signHashFor, type Via } from '../home/onboarding';
import { toWire } from './delegation';
import { issueMessagingWire } from './messaging-wire';
import { approveMessagingRecipient } from './messaging-send';

export interface MessagingCeremonyInput {
  person: Address;
  /** The counterparty being approved. */
  recipient: Address;
  /** The person's credential route — passkey / wallet / KMS (`resolveVia(profile.credential, via)`). */
  via: Via;
  /** Home session token. KMS routes need it; passkey and wallet do not. */
  token?: string | null;
}

/**
 * Run the ceremony: read what the current wire covers, mint one covering that plus `recipient`, have
 * the PERSON sign it, install it.
 *
 * Fail-closed at every step, and deliberately not wrapped in a retry: a person who declines the
 * prompt has declined, and asking again is how a signature request becomes noise.
 */
export async function approveMessagingContact(input: MessagingCeremonyInput): Promise<void> {
  await approveMessagingRecipient({
    person: input.person,
    newRecipient: input.recipient,
    mintWire: async ({ person, sessionKey, recipients }) => {
      // The credential-routed signer. `signHashFor` is what decides whether this opens a passkey
      // prompt, a wallet popup, or a server-side KMS signature — routing by the person's credential
      // and never by a raw session field, which is what stops a KMS home from popping MetaMask.
      const signHash = await signHashFor(input.via, person, input.token ? { token: input.token } : undefined);
      // `toWire` is NOT cosmetic: a `Delegation`'s salt is a bigint, `JSON.stringify` throws on one,
      // and the throw surfaces as "Do not know how to serialize a BigInt" from inside the POST —
      // nowhere near the mint that produced it. Every other client that ships a delegation does this;
      // this one did not, and only a live run found it. The wire form is also what the agent expects.
      return toWire(await issueMessagingWire({ personSA: person, sessionKey, recipients, signHash }));
    },
  });
}
