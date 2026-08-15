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
import { activateInboxDeliveryIfNeeded, activateInteractionsIfNeeded, signHashFor, type Via } from '../home/onboarding';
import { toWire } from './delegation';
import { issueMessagingTransportGrant, issueMessagingWire } from './messaging-wire';
import { approveMessagingRecipient } from './messaging-send';

export interface MessagingCeremonyInput {
  /**
   * The agent that will send — a person, or an ORGANIZATION the caller stewards.
   *
   * For an org, `signHashFor(via, orgSA, …)` is what signs: the steward's own credential produces a
   * signature that the ORG's account validates (approved-hash / ERC-1271 through its custody module).
   * That is the same route the spec-329 routing ceremony takes, and it is why no org key exists
   * anywhere — the org never holds one, and the steward never becomes the org.
   */
  person: Address;
  /** The counterparty being approved. */
  recipient?: Address;
  /** Several counterparties in one signature (join / enroll). */
  recipients?: readonly Address[];
  /** The org's stewardship delegation. Required when `person` is an organization. */
  stewardship?: unknown;
  /** The person's credential route — passkey / wallet / KMS (`resolveVia(profile.credential, via)`). */
  via: Via;
  /** Home session token. KMS routes need it; passkey and wallet do not. */
  token?: string | null;
}

/** Addresses this community currently lists. The wire names people, not the org. */
export async function communityMemberAddresses(org: string, token: string): Promise<Address[]> {
  const r = await fetch(`/connect/directory?communityId=${encodeURIComponent(org.toLowerCase())}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const d = (await r.json().catch(() => ({}))) as { listings?: Array<{ listing?: { subject?: string }; subject?: string }> };
  const out: Address[] = [];
  for (const row of d.listings ?? []) {
    const subject = String(row.listing?.subject ?? row.subject ?? '');
    const addr = subject.match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (addr) out.push(addr.toLowerCase() as Address);
  }
  return [...new Set(out)];
}

export async function approveMessagingContact(input: MessagingCeremonyInput): Promise<void> {
  await approveMessagingRecipient({
    person: input.person,
    ...(input.recipient ? { newRecipient: input.recipient } : {}),
    ...(input.recipients?.length ? { newRecipients: input.recipients } : {}),
    ...(input.stewardship ? { stewardship: input.stewardship } : {}),
    mintWire: async ({ person, sessionKey, recipients }) => {
      // The credential-routed signer. `signHashFor` is what decides whether this opens a passkey
      // prompt, a wallet popup, or a server-side KMS signature — routing by the person's credential
      // and never by a raw session field, which is what stops a KMS home from popping MetaMask.
      const signHash = await signHashFor(input.via, person, input.token ? { token: input.token } : undefined);
      // TWO delegations, ONE consent. They answer different questions — may this key sign as me, and
      // may I invoke this skill on these agents — and the gate needs both. It is one approval because
      // it is one decision; a person who wanted the first without the second could do nothing with it.
      // A wallet home sees two prompts here; passkey and KMS homes see none extra.
      //
      // `toWire` is NOT cosmetic: a `Delegation`'s salt is a bigint, `JSON.stringify` throws on one,
      // and the throw surfaces as "Do not know how to serialize a BigInt" from inside the POST —
      // nowhere near the mint that produced it. Only a live run found that.
      const wire = toWire(await issueMessagingWire({ personSA: person, sessionKey, recipients, signHash }));
      const transport = toWire(await issueMessagingTransportGrant({ personSA: person, recipients, signHash }));
      return { wire, transport };
    },
  });
}

/**
 * Storage, delivery, and a wire covering this community — signed once at join / enroll
 * so the first send from a relying app is not a second ceremony.
 */
export async function provisionCommunityMessaging(input: {
  person: Address;
  org?: string;
  extra?: readonly Address[];
  via: Via;
  token: string;
}): Promise<void> {
  const auth = { token: input.token };
  await activateInteractionsIfNeeded(input.person, input.via, auth);
  await activateInboxDeliveryIfNeeded(input.person, input.via, auth);
  const members = input.org
    ? await communityMemberAddresses(input.org, input.token).catch(() => [])
    : [];
  const self = input.person.toLowerCase();
  const recipients = [...members, ...(input.extra ?? [])].filter((a) => a.toLowerCase() !== self);
  if (recipients.length === 0) return;
  await approveMessagingContact({
    person: input.person,
    recipients,
    via: input.via,
    token: input.token,
  });
}
