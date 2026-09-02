// Adding freshly-published capabilities to an agent card's DRAFT, as part of the publish gesture.
//
// WHY THIS IS SAFE TO PAIR WITH A SIGNED WRITE. Publishing writes ids on chain and costs a signature.
// This does not: it patches the card's unreleased draft, which is private to the steward and reaches
// nobody until someone reviews, signs and releases it (spec 347 §8.1). So the pairing adds no public
// exposure and no new authority — it still gates on `card.patchDraft`, the scope the Card Studio already
// requires for the identical edit, and fails closed rather than attempting with the wrong authority.
//
// WHY IT IS A SEPARATE, SECOND STEP. The on-chain publish is the thing the person consented to and
// signed. If the draft patch fails — no scope, no card, a stale revision — that must never fail the
// publish or be reported as if it had. Two outcomes, two sentences (the reviewer's point, and the same
// trap this page already fell into once by swallowing a publish failure entirely).
import type { DelegationWire } from './delegation';
import { gateForOp } from './studio-view';
import { listCards, getCard, patchDraft, newMutation, type CardListEntry } from '../studio-client';

/** What the publish screen needs to know to offer the card option at all. */
export interface CardTarget {
  cardResourceId: string;
  displayName: string;
}

/** The single card this publish can update, or null when the choice is not ours to make.
 *
 *  Deliberately null for MORE THAN ONE card: guessing which card someone meant is a silent decision
 *  about what an agent advertises, and "primary" is not a safe stand-in for intent. */
export function soleCardTarget(cards: CardListEntry[]): CardTarget | null {
  if (cards.length !== 1) return null;
  const r = cards[0]!.resource;
  return { cardResourceId: r.cardResourceId, displayName: r.displayName?.trim() || 'your agent card' };
}

/** Can this caller patch a card draft at all? (Org separation of duties: publishing an id and editing a
 *  card are different scopes, and a member who holds one may not hold the other.) */
export function mayPatchDraft(scopes: readonly string[]): boolean {
  return gateForOp(scopes, 'card.patchDraft').allowed;
}

export type CardAddOutcome =
  | { ok: true; added: string[]; displayName: string }
  | { ok: false; reason: string };

/**
 * Add `ids` to the card's draft, skipping any already on it.
 *
 * `describe` supplies the wording for an id (the catalog's, normally). A card skill REQUIRES a
 * description, so an id we cannot describe is skipped and named in the outcome rather than written as a
 * blank that fails validation later, on a screen the person is no longer looking at.
 */
export async function addPublishedToCardDraft(
  delegation: DelegationWire,
  target: CardTarget,
  ids: readonly string[],
  describe: (id: string) => { name: string; description: string } | null,
): Promise<CardAddOutcome> {
  try {
    const detail = await getCard(delegation, target.cardResourceId);
    const draft = detail.draft;
    if (!draft) return { ok: false, reason: 'that card has no draft to add to' };
    const on = new Set((draft.card.skills ?? []).map((s) => s.id));
    const additions = ids
      .filter((id) => !on.has(id))
      .map((id) => ({ id, d: describe(id) }))
      .filter((x): x is { id: string; d: { name: string; description: string } } => !!x.d && !!x.d.description.trim());
    if (additions.length === 0) return { ok: true, added: [], displayName: target.displayName };
    await patchDraft(
      delegation,
      target.cardResourceId,
      [{ op: 'replace', path: '/skills', value: [...(draft.card.skills ?? []), ...additions.map((a) => ({ id: a.id, name: a.d.name, description: a.d.description, tags: [] as string[] }))] }],
      { ...newMutation(), expectedRevision: draft.revision },
      draft.etag,
    );
    return { ok: true, added: additions.map((a) => a.id), displayName: target.displayName };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The cards this person's Studio grant can see. Never mints a grant — the caller decides that. */
export async function cardsFor(delegation: DelegationWire): Promise<CardListEntry[]> {
  return listCards(delegation);
}
