import { test, expect, type Page } from '@playwright/test';
import { CAST, onboardPersona } from './demo-user';
import { estateDomain } from './estate';

// THE AGENTIC INTERACTION SUBSTRATE, ASSERTED ON DIRECTLY (ADR-0058 / spec 340).
//
// THE GAP THIS CLOSES. Every other e2e here asserts on rendered TEXT: a topic appears, a gate refuses, a
// message shows up in a list. That proves the product, not the substrate — a regression in
// `MessageEnvelopeV1`, in the event stream, or in the case model that still renders correctly passes every
// one of them. The substrate is well covered at unit level (fabric's own suites), and nothing joined the
// two: no test drove a real flow through real apps and then looked at the OBJECTS it produced.
//
// WHAT IS READ, and why this one rather than the raw doc. `/connect/inbox` is what the Messages page
// actually fetches, and its `envelopeMeta` carries the substrate facts the app consumes: `performative`,
// `inReplyTo`, `interactionId`, `signatureSigner`, `actor`. Asserting HERE is stronger than asserting on
// `InboxDataV1` would be, because a substrate change that never reaches the projection is a change no app
// can act on. (I tried the raw doc first: `inbox.get` wants the session in the request BODY and answered a
// hand-built fetch with `401 bridge envelope missing`.)
//
// WHAT IS ASSERTED — invariants from the doctrine, not field spelling:
//   1. Every envelope carries a `bodyHash`. The body travels separately and is verified against it
//      (spec 309 §8.4); an envelope without one makes its body unverifiable.
//   2. Lifecycle is an EVENT STREAM, not a mutated field — `sent`/`delivered`/`seen` are appended facts.
//   3. `delivered`/`seen` are INBOX read-receipt facts, never case states (spec 316, Blocker 6).
//   4. Communication (T0) carries NO case. A plain message is not a governed situation.
//   5. A message is never authority (ADR-0041) — no envelope carries a grant, delegation or capability.
//
// These are stated so a failure NAMES the doctrine it broke, rather than reporting a shape mismatch.

interface EnvelopeMeta {
  from?: string;
  /** V1 ONLY. Absent on `ap.message.v2`, which dropped the taxonomy — absence must NOT be read as "not plain". */
  kind?: string;
  /** BOTH versions, via the dual-read seam: what the message DOES. */
  performative?: string;
  /** The causal edge. Under V2 this — not a taxonomy — is what makes a reply a reply (spec 340 §R.4). */
  inReplyTo?: string;
  /** Present only when the exchange belongs to a governed situation. An Exchange without one IS a message. */
  interactionId?: string;
  signatureSigner?: string;
  createdAt?: string;
  actor?: string;
}
/** The governed-situation half: a case is a request under review, a card is what the owner is offered,
 *  a mandate is the ONLY thing that confers authority when they approve (spec 336, ADR-0041). */
interface Case {
  id?: string;
  kind?: string;
  requester?: string;
  state?: string;
  authorityRef?: { kind?: string; hash?: string };
}
interface Mandate {
  version?: string;
  mandateId?: string;
  principal?: string;
  actingAgent?: string;
  delegationHash?: string;
  signature?: unknown;
}
interface InboxView {
  envelopeMeta?: Record<string, EnvelopeMeta>;
  conversations?: unknown[];
  descriptors?: Record<string, unknown>;
  items?: unknown[];
  cases?: Case[];
  cards?: Record<string, unknown>;
  mandates?: Record<string, Mandate>;
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(34)} ${detail.slice(0, 100)}`);
};

/**
 * Capture the inbox document from the app's OWN poll.
 *
 * NOT by calling `inbox.get` ourselves. It is owner-facing and wants the session in the request BODY, so a
 * hand-built `fetch({})` earns `401 unauthorized: bridge envelope missing` — a finding about my request,
 * not about the substrate. (`status` worked that way only because it is handled before that gate; I
 * generalised from one endpoint and was wrong.) The Messages page already polls this every few seconds
 * with the envelope the gate wants, so listening is both correct and free.
 *
 * THIRD TIME TODAY that watching the app beat asking it — the principal address, the org applications doc,
 * and now this. Worth stating as a rule: if the app already makes the call, take its answer.
 */
function watchInbox(page: Page): { latest: () => InboxView | null } {
  let seen: InboxView | null = null;
  page.on('response', async (r) => {
    if (!/\/connect\/inbox(\?|$)/.test(r.url()) || r.status() !== 200) return;
    try {
      const parsed = JSON.parse(await r.text()) as InboxView;
      // Keep the RICHEST view seen. The page fetches this repeatedly with different query params, and a
      // later, narrower response would otherwise overwrite a fuller earlier one.
      if (parsed.envelopeMeta && Object.keys(parsed.envelopeMeta).length >= Object.keys(seen?.envelopeMeta ?? {}).length) seen = parsed;
    } catch { /* a body we cannot parse is not a view */ }
  });
  return { latest: () => seen };
}

test('the interaction substrate holds, asserted on the objects themselves', async ({ browser }) => {
  test.setTimeout(1_200_000);

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  // BO, THE RECIPIENT. `ada` sends in `demo-cast-history`, so her projection holds no received mail and
  // every invariant below went vacuous on the first run — which the `.present` guard correctly refused to
  // report as six passes. The substrate facts being checked (performative, inReplyTo, interactionId,
  // signer, actor) are properties of RECEIVED messages, so the receiver is the right side to read.
  const home = await onboardPersona(pageA, CAST.bo);
  expect(home.origin, 'bo never reached a home').toContain(estateDomain());

  // PRODUCE THE MESSAGE THIS SPEC ASSERTS ON. Reading a persona's existing mail made the run depend on
  // whatever a previous spec happened to leave behind — and on the first two attempts it left nothing, so
  // every invariant went vacuous. (It also exposed a weak assertion elsewhere: `demo-cast-history`'s
  // `chat.receive` matched /message/i, which the "Messages" nav item satisfies whether mail arrived or not.)
  const ctxS = await browser.newContext();
  const pageS = await ctxS.newPage();
  const sender = await onboardPersona(pageS, CAST.ada);
  await pageS.goto(`${sender.origin}/messages`);
  await pageS.waitForTimeout(5000);
  await pageS.getByRole('button', { name: /Compose|New message/i }).first().click().catch(() => {});
  await pageS.waitForTimeout(1500);
  const search = pageS.getByPlaceholder(/name|search|who/i).first();
  await search.fill(CAST.bo.name).catch(() => {});
  await pageS.getByRole('button', { name: /^Search$/i }).first().click().catch(() => {});
  let found = false;
  for (let i = 0; i < 8; i++) {
    await pageS.waitForTimeout(4000);
    if (new RegExp(CAST.bo.name, 'i').test(await pageS.locator('body').innerText().catch(() => ''))) { found = true; break; }
  }
  if (found) {
    await pageS.getByText(new RegExp(CAST.bo.name, 'i')).first().click().catch(() => {});
    await pageS.waitForTimeout(1000);
    await pageS.getByPlaceholder(/Write your message/i).first().fill(`substrate probe ${new Date().toISOString()}`).catch(() => {});
    const sendBtn = pageS.locator('button.chat-send-btn, button[aria-label="Send message"]').first();
    await sendBtn.click().catch(() => {});
    await pageS.waitForTimeout(6000);
    // First-time wire ceremony, if this pair has never spoken.
    const approve = pageS.getByRole('button', { name: /^Approve$/ }).first();
    if (await approve.count().catch(() => 0)) {
      await approve.click().catch(() => {});
      for (let i = 0; i < 20; i++) {
        await pageS.waitForTimeout(5000);
        if (/sent|delivered/i.test(await pageS.locator('body').innerText().catch(() => ''))) break;
      }
    }
  }
  console.log(`[substrate] sender=${CAST.ada.name} → ${CAST.bo.name} recipientFound=${found}`);
  await ctxS.close();

  const inbox = watchInbox(pageA);
  await pageA.goto(`${home.origin}/messages`);
  // Give the page time to poll at least once. The document arrives on ITS schedule, not ours.
  for (let i = 0; i < 12 && !inbox.latest(); i++) await pageA.waitForTimeout(5000);
  const view = inbox.latest();
  const metas = Object.entries(view?.envelopeMeta ?? {});
  console.log(`[substrate] envelopeMeta=${metas.length} conversations=${view?.conversations?.length ?? 0}`);
  if (!view) {
    // Its own outcome. "I could not read the projection" is not "the projection is wrong", and returning
    // the second when the first happened is how a mechanism gets believed without evidence.
    check('inbox.readable', false, '/connect/inbox never returned a view — nothing below was checked');
    expect(view, '/connect/inbox returned no view').not.toBeNull();
    return;
  }
  check('inbox.readable', true, `${metas.length} envelopes projected`);

  if (metas.length === 0) {
    // Said out loud. Five checks over an empty array are vacuously true, and reporting them as passes is
    // how a suite starts claiming coverage it does not have.
    check('envelopes.present', false, 'no envelopes — every invariant below is VACUOUS, not passing');
  } else {
    check('envelopes.present', true, `${metas.length} envelopes`);

    // 1. `performative` is the DUAL-READ SEAM (spec 340 §R.4): what the message DOES, present under both
    //    v1 and v2. `kind` is the v1 taxonomy and is absent on v2 — so performative is the field a reader
    //    may rely on, and its absence would leave the app unable to say what any message is.
    const noPerf = metas.filter(([, m]) => !m.performative);
    check('every message says what it DOES', noPerf.length === 0,
      noPerf.length ? `${noPerf.length} without performative: ${noPerf[0]?.[0]}` : `${metas.length} carry performative`);

    // 2. ABSENCE OF `kind` IS NOT A CLASSIFICATION. The v2 envelope dropped the taxonomy, and the field's
    //    own doc says readers MUST branch on presence rather than infer "not plain" from absence. So a
    //    v2 message (no kind) must still be fully described — which it is, iff performative is set.
    const kindless = metas.filter(([, m]) => m.kind === undefined);
    const kindlessDescribed = kindless.every(([, m]) => !!m.performative);
    check('v2 messages need no taxonomy', kindlessDescribed,
      `${kindless.length}/${metas.length} are v2-shaped (no kind); all describable: ${kindlessDescribed}`);

    // 3. ADR-0058 — AN EXCHANGE WITHOUT AN INTERACTION IS A MESSAGE. `interactionId` is therefore
    //    legitimately absent on ordinary mail, and its presence must be a real id rather than a
    //    placeholder. A blank or `current`/`latest` value would be a historical record naming a moving
    //    target, which the spec forbids outright.
    const pinned = metas.filter(([, m]) => m.interactionId !== undefined);
    const badPin = pinned.filter(([, m]) => !m.interactionId?.trim() || /^(current|latest)$/i.test(m.interactionId));
    check('interaction refs are pinned, never floating', badPin.length === 0,
      badPin.length ? `${badPin.length} floating/blank interactionId` : `${pinned.length}/${metas.length} in a governed situation`);

    // 4. A REPLY IS A CAUSAL EDGE, not a taxonomy (spec 340 §R.4). Where `inReplyTo` is set it must name
    //    a message, not be an empty string standing in for "yes this is a reply".
    const replies = metas.filter(([, m]) => m.inReplyTo !== undefined);
    const badReply = replies.filter(([, m]) => !m.inReplyTo?.trim());
    check('replies name their cause', badReply.length === 0,
      badReply.length ? `${badReply.length} blank inReplyTo` : `${replies.length} replies, each with a cause`);

    // 5. ADR-0041 — A MESSAGE IS NEVER AUTHORITY. Nothing in the projection may carry a grant, delegation,
    //    capability or entitlement: if it did, reading your mail would be a way to acquire permission.
    const authorityish = metas.filter(([, m]) =>
      Object.keys(m).some((k) => /delegation|grant|capability|entitlement|authoriz/i.test(k)));
    check('no message carries authority', authorityish.length === 0,
      authorityish.length ? `ADR-0041 violation on ${authorityish[0]?.[0]}: ${Object.keys(authorityish[0]![1]).join(',')}` : 'ADR-0041 upheld');

    // 6. PROVENANCE. Every message names a sender and a time; `actor` distinguishes the acting agent from
    //    the person it acted for (spec 328 / 324 §9) and is absent when they are the same party.
    const noOrigin = metas.filter(([, m]) => !m.from || !m.createdAt);
    check('every message has an origin', noOrigin.length === 0,
      noOrigin.length ? `${noOrigin.length} missing from/createdAt` : `${metas.filter(([, m]) => m.actor).length} acted by an agent`);
  }

  // ── THE GOVERNED-SITUATION HALF (spec 340 · ADR-0041 · spec 336) ────────────────────────────────
  //
  // A case is a request under review; a card is what the owner is offered; a MANDATE is the only thing
  // that confers authority when they approve. Nine of ten steps in that chain grant nothing — the
  // separation IS the doctrine, and it is what these check.
  //
  // ABSENCE IS LEGAL AND IS REPORTED AS UNEXERCISED, never as a pass. A plain DM produces no case, so a
  // suite that counted "no cases, therefore no violations" would grow greener the less it covered.
  const cases = view.cases ?? [];
  const mandates = Object.entries(view.mandates ?? {});
  const cards = Object.keys(view.cards ?? {});
  console.log(`[substrate] cases=${cases.length} cards=${cards.length} mandates=${mandates.length}`);

  if (cases.length === 0) {
    check('cases.exercised', false, 'no case in this inbox — the governed-situation invariants went UNEXERCISED');
  } else {
    check('cases.exercised', true, `${cases.length} cases`);

    // A case names WHO asked and WHERE it is. Without a requester there is nobody the decision is about;
    // without a state it reads as whatever the viewer assumes.
    const anon = cases.filter((c) => !c.requester || !c.state);
    check('every case names its requester and state', anon.length === 0,
      anon.length ? `${anon.length} case(s) missing requester/state` : `${cases.length} well-formed`);

    // ADR-0041, THE CENTRAL ONE. An approved case may point at authority; it may never BE it. Where an
    // `authorityRef` exists it must be a REFERENCE (kind + hash) — a case carrying an inline delegation
    // would mean approving something granted it, which is the confusion the whole model exists to prevent.
    const approved = cases.filter((c) => /approv/i.test(c.state ?? ''));
    const inlineAuthority = approved.filter((c) => {
      const ref = c.authorityRef as Record<string, unknown> | undefined;
      return ref !== undefined && (!ref.hash || !ref.kind || Object.keys(ref).some((k) => /caveat|signature|delegator/i.test(k)));
    });
    check('approval REFERENCES authority, never carries it', inlineAuthority.length === 0,
      inlineAuthority.length ? `case ${inlineAuthority[0]?.id} embeds authority instead of referencing it`
        : `${approved.length} approved case(s), all by reference`);
  }

  if (mandates.length === 0) {
    check('mandates.exercised', false, 'no mandate issued — the only step that CONFERS authority is untested here');
  } else {
    check('mandates.exercised', true, `${mandates.length} mandates`);

    // A mandate is the authorizing artifact, so it must be signed and must name both ends: the principal
    // it speaks for and the agent it empowers. An unsigned one is a claim, not a mandate.
    const weak = mandates.filter(([, m]) => !m.signature || !m.principal || !m.actingAgent || !m.delegationHash);
    check('every mandate is signed and two-ended', weak.length === 0,
      weak.length ? `${weak.length} mandate(s) missing signature/principal/actingAgent/delegationHash` : `${mandates.length} complete`);

    // The case's authorityRef must be the MANDATE's delegation hash (inbox-data.ts:397). If they can
    // drift, the record of what authorized an approval stops matching what was actually issued.
    const hashes = new Set(mandates.map(([, m]) => m.delegationHash?.toLowerCase()).filter(Boolean));
    const orphanRefs = cases.filter((c) => c.authorityRef?.hash && !hashes.has(c.authorityRef.hash.toLowerCase()));
    check('case authority matches an issued mandate', orphanRefs.length === 0,
      orphanRefs.length ? `case ${orphanRefs[0]?.id} refs a hash no mandate issued` : 'refs and mandates agree');
  }

  console.log('\n── substrate invariants ──');
  const bad = results.filter((r) => !r.ok);
  console.log(`${results.length - bad.length}/${results.length} held`);
  for (const b of bad) console.log(`  FAIL  ${b.name}  ${b.detail}`);

  // Only the DOCTRINE checks fail the run. "No envelopes yet" is a coverage gap, reported above and not
  // fatal — failing on it would make the suite red for a quiet mailbox rather than for a broken model.
  // `.present` / `.exercised` are COVERAGE reports, not doctrine. Failing on them would make the suite
  // red for a quiet mailbox rather than for a broken model — but they are printed above, so an
  // unexercised half cannot be mistaken for a verified one.
  const doctrine = results.filter((r) => !r.ok && !r.name.endsWith('.present') && !r.name.endsWith('.exercised'));
  expect(doctrine, `substrate invariant(s) broken: ${doctrine.map((d) => `${d.name} — ${d.detail}`).join(' | ')}`).toEqual([]);
});
