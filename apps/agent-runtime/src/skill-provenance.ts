// spec bridge — skill-provenance/v1: when a SkillHandler produces an Artifact, tag
// it with the verifiable SKILL.md that shaped it. The reference (canonical id +
// content digest + publisher) is resolved from the external skills corpus; a
// receiver re-checks it against that corpus, so the tag proves the skill was used
// rather than merely naming it.
//
// Inert unless SKILLS_CORPUS_URL is set (mirrors PUBLIC_GRAPH_URL), and fail-open:
// any resolve error → no metadata attached, the artifact is emitted unchanged.

import type { Address } from 'viem';

export interface SkillProvenanceEnv {
  SKILLS_CORPUS_URL?: string;
}

export const SKILL_PROVENANCE_EXT_URI = 'https://agentictrust.io/a2a/extensions/skill-provenance/v1';

const SKILLSET = 'public';
const TIMEOUT_MS = 8000;

/** True when provenance tagging is configured. */
export function skillProvenanceEnabled(env: SkillProvenanceEnv): boolean {
  return !!String(env.SKILLS_CORPUS_URL ?? '').trim();
}

/**
 * Map an A2A skill selector (`orchestrate`, `discussion.consult`) to a corpus
 * canonical id (`skill:public/<slug>`). There is no on-chain table for this yet;
 * this derivation is the natural key. Override by publishing the matching
 * canonical id into the corpus.
 */
export function canonicalSkillId(skill: string): string {
  const slug = skill.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `skill:${SKILLSET}/${slug}`;
}

interface SkillReferenceResponse {
  reference: { id: string; uri?: string; version?: number; skillMdDigest?: string; publisherAgentId?: string };
  proof?: { leafIndex: number; commitment: string; proof: string[]; root: string; included: boolean; snapshotVersion: number } | null;
}

async function resolveSkillReference(
  env: SkillProvenanceEnv,
  canonicalId: string,
): Promise<SkillReferenceResponse | null> {
  const base = String(env.SKILLS_CORPUS_URL ?? '').trim();
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}/tools/skill_reference?skillset=${SKILLSET}&id=${encodeURIComponent(canonicalId)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return (await r.json()) as SkillReferenceResponse;
  } catch {
    return null; // fail-open — provenance is best-effort, never blocks the artifact
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the `metadata` block to pass to `ctx.emitArtifact({ metadata })`, or
 * `undefined` when provenance is disabled or the skill isn't in the corpus.
 */
export async function skillProvenanceMetadata(
  env: SkillProvenanceEnv,
  opts: { skill: string; agentSA: Address; taskId: string; reason?: string },
): Promise<Record<string, unknown> | undefined> {
  const canonicalId = canonicalSkillId(opts.skill);
  const resolved = await resolveSkillReference(env, canonicalId);
  if (!resolved || !resolved.reference) return undefined;

  const executionId = `${opts.taskId}:${opts.skill}`;
  const execution: Record<string, unknown> = {
    executionId,
    skill: resolved.reference,
    agentId: opts.agentSA,
    ...(opts.reason ? { activationReason: opts.reason } : {}),
    ...(resolved.proof ? { inclusion: resolved.proof } : {}),
  };
  return {
    [SKILL_PROVENANCE_EXT_URI]: {
      extension: SKILL_PROVENANCE_EXT_URI,
      executions: [execution],
      contributions: [{ executionId, target: { type: 'artifact' }, contribution: 'generated' }],
    },
  };
}

// ── spec 354 §4.5 — the PLAYBOOK provenance manifest, built from a run's receipts ────────────────────
//
// The archetype that shaped a run is named on every StepReceipt as `skillRef` (canonical id + version +
// definition digest). Unlike the corpus-resolved variant above, this needs NO fetch: the digest IS the
// content commitment, so the manifest is meaningful even when SKILLS_CORPUS_URL is unset — a receiver
// re-derives the definition digest and checks THAT against the corpus (by digest), proving which
// procedure the agent followed. Grants nothing; a playbook is never authority (spec 354 §1).

interface ReceiptWithSkillRef { runRef?: string; skillRef?: { skillId: string; version: string; commitment: string } }

/**
 * Build the `skill-provenance/v1` manifest for an outbound artifact from a run's receipts, or undefined
 * when no receipt names a playbook (the agent ran the bare harness). One run is shaped by one playbook,
 * so distinct skillRefs collapse to one execution per (id, version, commitment).
 */
export function playbookProvenanceFromReceipts(
  receipts: ReadonlyArray<ReceiptWithSkillRef>,
  agentSA: Address,
): Record<string, unknown> | undefined {
  const seen = new Map<string, { skillId: string; version: string; commitment: string; runRef?: string }>();
  for (const r of receipts) {
    if (!r.skillRef) continue;
    const key = `${r.skillRef.skillId}@${r.skillRef.version}:${r.skillRef.commitment}`;
    if (!seen.has(key)) seen.set(key, { ...r.skillRef, ...(r.runRef ? { runRef: r.runRef } : {}) });
  }
  if (seen.size === 0) return undefined;
  const executions = [...seen.values()].map((s) => {
    const executionId = `${s.runRef ?? 'run'}:${s.skillId}`;
    return {
      executionId,
      // The corpus reference shape, filled from the receipt: id + version + the digest as the content
      // commitment. `included` is unproven here (no fetch) — a verifier resolves the inclusion proof.
      skill: { id: s.skillId, version: s.version, skillMdDigest: s.commitment },
      agentId: agentSA,
      activationReason: 'archetype playbook admitted the run',
    };
  });
  return {
    [SKILL_PROVENANCE_EXT_URI]: {
      extension: SKILL_PROVENANCE_EXT_URI,
      executions,
      contributions: executions.map((e) => ({ executionId: e.executionId, target: { type: 'artifact' }, contribution: 'shaped' })),
    },
  };
}
