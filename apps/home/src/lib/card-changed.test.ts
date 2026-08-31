/**
 * "I made changes and there is no Save."
 *
 * The card page decided whether a draft differed from what was released by comparing
 * `draft.basedOnReleaseId` to the latest release id. That field records which release the draft was
 * FORKED FROM — it does not move when you edit the description. So after the first save, every later
 * edit left it pointing at that same release, `draftChanged` stayed false, `planPublish` short-circuited
 * to `live`, and the Save button never rendered: you could type into the card and have no way to save it.
 *
 * The honest signal is the content itself, under the same canonicalisation a release is cut with. These
 * pin the two halves: the digest actually moves when the card is edited (so the comparison detects it),
 * and `planPublish` offers a save exactly when it does.
 */
import { describe, it, expect } from 'vitest';
import { cardContentDigest } from '@agenticprimitives/agent-profile/a2a';
import { planPublish } from './studio-flow';

const card = (over: Record<string, unknown> = {}) => ({
  protocolVersion: '1.0',
  name: 'ncf.workspace',
  description: 'A2A endpoint for ncf.workspace.',
  version: '0.1.0',
  skills: [],
  supportedInterfaces: [{ url: 'https://ncf-workspace.faithnet.ai/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  ...over,
}) as never;

describe('a card that changed has a different digest', () => {
  it('the same card twice is the same digest — canonical, not incidental ordering', () => {
    expect(cardContentDigest(card())).toBe(cardContentDigest(card()));
  });

  it('editing the DESCRIPTION moves the digest (the case that had no Save)', () => {
    expect(cardContentDigest(card({ description: 'Now it says something else.' }))).not.toBe(cardContentDigest(card()));
  });

  it('editing the endpoint moves it too', () => {
    const moved = card({ supportedInterfaces: [{ url: 'https://elsewhere.example/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
    expect(cardContentDigest(moved)).not.toBe(cardContentDigest(card()));
  });
});

describe('planPublish offers a save exactly when the content differs', () => {
  const scopes = ['agent.card.draft', 'agent.card.approve', 'agent.card.sign', 'agent.card.publish'];
  const published = { state: 'published' as const };

  it('offers nothing when the released card IS what is on screen', () => {
    expect(planPublish({ draftState: 'validated', errors: 0, release: published, draftChanged: false, scopes }).kind).toBe('live');
  });

  it('offers a save the moment the content differs — even though the release is still published', () => {
    // The exact regression: a published release used to mean "live", whatever the draft said.
    const plan = planPublish({ draftState: 'draft', errors: 0, release: published, draftChanged: true, scopes });
    expect(plan.kind).toBe('ready');
    if (plan.kind === 'ready') expect(plan.runnable).toContain('publish');
  });

  it('still refuses while something is genuinely wrong with the description', () => {
    expect(planPublish({ draftState: 'draft', errors: 2, release: published, draftChanged: true, scopes }).kind).toBe('blocked');
  });
});
