/**
 * THE BODY IS THE PRODUCT (2026-10-15, skills docs/cil-commons/record-first-2026-10-14.md).
 *
 * A writer skill whose body states "the record this run produces" ends every answer with a fenced ```record block —
 * under any harness, whether or not this one appended its own ask. The ask (`skill/record: on`, `recordsFor`) is the
 * comparison's instruction; the BLOCK is what the record effect writes and the state check reads. So the invoker reads
 * the block off every answer, and says "asked" / "no block" only when it asked.
 */
import { describe, it, expect } from 'vitest';
import { skillApplyInvoker } from '../src/skill-apply.js';

const CLS = 'https://skills.demo/cil-commons#IncidentPlaybook';
const answerWith = (block: string) => `# Playbook\n\nThe runbook.\n\n${block}`;
const BLOCK = '```record\n[{"@type":"' + CLS + '","label":"Runbook","playbookClass":"privacy-leak"}]\n```';

function invoker(answer: string, recordsFor?: () => Array<{ iri: string; label: string; requiredFields: string[] }>) {
  return skillApplyInvoker({
    call: async () => ({ answer }),
    sources: { t: { skillId: 'skill:cil-commons-ol/ai-incident-response-playbook-builder', version: '0.3.0', contractDigest: 'sha256:abc' } },
    readSkill: async () => ({ body: '…the body…', commitment: 'sha256:abc' }) as never,
    ...(recordsFor ? { recordsFor } : {}),
  });
}

describe('a record block is read off every answer', () => {
  it('with no ask from the harness, a body-stated block still yields records and leaves the prose', async () => {
    const r = (await invoker(answerWith(BLOCK))('t', { question: 'build a playbook' })) as { answer: string; records?: Array<{ class: string; record: Record<string, unknown> }>; recordsAsked?: string[]; recordError?: string };
    expect(r.records).toEqual([{ class: CLS, record: { label: 'Runbook', playbookClass: 'privacy-leak' } }]);
    expect(r.answer).toBe('# Playbook\n\nThe runbook.');
    expect(r.recordsAsked).toBeUndefined();
    expect(r.recordError).toBeUndefined();
  });
  it('with no ask and no block, the answer is untouched and nothing is said', async () => {
    const r = (await invoker('# Playbook\n\nThe runbook.')('t', { question: 'q' })) as { answer: string; records?: unknown; recordError?: string };
    expect(r.answer).toBe('# Playbook\n\nThe runbook.');
    expect(r.records).toBeUndefined();
    expect(r.recordError).toBeUndefined();
  });
  it('with the ask and no block, the miss is named', async () => {
    const r = (await invoker('# Playbook', () => [{ iri: CLS, label: 'Incident Playbook', requiredFields: ['playbookClass'] }])('t', { question: 'q' })) as { recordsAsked?: string[]; recordError?: string };
    expect(r.recordsAsked).toEqual([CLS]);
    expect(r.recordError).toBe('the answer carried no record block');
  });
});
