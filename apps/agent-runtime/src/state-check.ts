// THE OUTCOME IS STATE — 2026-10-14 ("evals article gap" W3). The article's rule: grade the result in the world, not
// the agent's words. For an instruction skill the result is a TYPED RECORD — a Governance Scorecard, a Decision Brief —
// written to the asker's vault and valid against its SHACL shape. The shape is the unit test; the ontology is the test
// environment. No containers.
//
// After a run under a comparison that carries the outcome gold, the ask route reads back the record of each class the
// GOLD plan produces (where the skill's declared RECORD effect put it) and validates it here against the definition's
// `domainShapes` (W3: the compiler carries each produced class's fields). Per class: exists · valid · errors[] — the
// REQUIRED fields decide pass; the other fields are handed to the outcome judge as quality dimensions, never pass/fail.
// A record missing `supportedBy` on a score is the groundedness failure (W5), named by field. Pure; the route binds
// the vault read.

/** One field of a class's shape, flat (what the compiler's `domainShapes` carries). */
export interface ShapeFieldV1 { name: string; path: string; minCount?: number; maxCount?: number; datatype?: string; class?: string; vocabulary?: string; allowed?: string[]; pattern?: string; minLength?: number }
export interface DomainShapeV1 { class: string; label: string; comment?: string; fields: ShapeFieldV1[] }

export interface ClassCheckV1 { exists: boolean; valid: boolean; errors: string[]; /** W5 — the required evidence edges this record lacks (`supportedBy` / `optionCites`). */ uncited?: number; /** An alternative output this class's group was satisfied by instead (the record of THAT class exists and validates). */ satisfiedBy?: string; /** The record read back was written by an EARLIER run (its runRef) — read as absent. */ stale?: string }
export interface StateCheckV1 { pass: boolean; classes: Record<string, ClassCheckV1>; /** Expected classes the definition has no shape for — checked for existence only, and said. */ unshaped: string[] }

/** THE RECORD TYPE OF A PRODUCED CLASS — one rule, used by the effect sink that writes it and the check that reads it.
 *  The domain's own mapping (`skills:mapsRecordType`, on the definition's `domainRecords`) wins; otherwise
 *  `<namespace label>.<class local name, kebab-case>` — `https://skills.demo/cil-commons#IncidentPlaybook` →
 *  `cil-commons.incident-playbook`. */
export function recordTypeOfClass(classIri: string, domainRecords?: ReadonlyArray<{ recordType: string; class: string }>): string {
  const mapped = domainRecords?.find((m) => m.class === classIri)?.recordType;
  if (mapped) return mapped;
  const [ns, local] = classIri.includes('#') ? [classIri.slice(0, classIri.indexOf('#')), classIri.slice(classIri.indexOf('#') + 1)] : [classIri.slice(0, classIri.lastIndexOf('/')), classIri.slice(classIri.lastIndexOf('/') + 1)];
  const nsLabel = (ns.split('/').filter(Boolean).pop() ?? 'domain').toLowerCase();
  const kebab = local.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  return `${nsLabel}.${kebab}`;
}

const EVIDENCE_FIELDS = new Set(['supportedBy', 'optionCites', 'recommendationEvidence']);
const IRIISH = /^[a-z][a-z0-9+.-]*:/i;

/** Validate ONE flat record against ONE shape — the live validator's rules: minCount / maxCount, allowed values for a
 *  vocabulary field, an IRI-ish value (or an object) where `sh:class` requires a reference, a pattern, a minLength. */
export function validateRecord(record: unknown, shape: DomainShapeV1): { valid: boolean; errors: string[]; uncited: number } {
  const errors: string[] = [];
  let uncited = 0;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { valid: false, errors: ['the record is not an object'], uncited: 0 };
  const rec = record as Record<string, unknown>;
  for (const f of shape.fields) {
    const raw = rec[f.name];
    const vals = raw === undefined || raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
    if (f.minCount !== undefined && vals.length < f.minCount) {
      errors.push(`missing "${f.name}"${f.minCount > 1 ? ` (needs ${f.minCount}, has ${vals.length})` : ''}`);
      if (EVIDENCE_FIELDS.has(f.name)) uncited++;
      continue;
    }
    if (f.maxCount !== undefined && vals.length > f.maxCount) errors.push(`"${f.name}" has ${vals.length}, at most ${f.maxCount}`);
    for (const v of vals) {
      const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
      if (f.allowed?.length && s !== null && !f.allowed.includes(s)) errors.push(`"${f.name}"=${JSON.stringify(s)} is not one of ${f.allowed.join(', ')}`);
      // A reference is an IRI, an object, or the referenced artifact's LABEL — the flat record names its parts by label
      // (the record instruction and the bodies' record section both say so, 2026-10-15); only a blank fails.
      if (f.class && s !== null && typeof v !== 'object' && !s.trim()) errors.push(`"${f.name}" must reference a ${f.class.split(/[#/]/).pop()} (an IRI or its label)`);
      if (f.pattern && s !== null && !new RegExp(f.pattern).test(s)) errors.push(`"${f.name}" does not match ${f.pattern}`);
      if (f.minLength !== undefined && s !== null && s.length < f.minLength) errors.push(`"${f.name}" is shorter than ${f.minLength}`);
    }
  }
  return { valid: errors.length === 0, errors, uncited };
}

/** The whole check: for each expected class, the record read (or null), validated against its shape when there is one. */
export function stateCheckOf(expected: ReadonlyArray<{ iri: string; alternative?: string }>, records: Record<string, unknown>, shapes: ReadonlyArray<DomainShapeV1>): StateCheckV1 {
  const classes: Record<string, ClassCheckV1> = {};
  const unshaped: string[] = [];
  for (const e of expected) {
    const rec = records[e.iri];
    const exists = rec !== undefined && rec !== null;
    const shape = shapes.find((s) => s.class === e.iri);
    if (!shape) { unshaped.push(e.iri); classes[e.iri] = { exists, valid: exists, errors: exists ? [] : ['no record'] }; continue; }
    if (!exists) { classes[e.iri] = { exists: false, valid: false, errors: ['no record'] }; continue; }
    const v = validateRecord(rec, shape);
    classes[e.iri] = { exists: true, valid: v.valid, errors: v.errors, ...(v.uncited ? { uncited: v.uncited } : {}) };
  }
  // ALTERNATIVE OUTPUTS (spec 418, `skills:alternativeGroup`): a drafter delivers a Letter of Inquiry OR a Grant Proposal. A
  // group is satisfied by any one member that exists and validates; the others are then not failures — they are said
  // (`satisfiedBy`), and the group fails only when no member is there. Found live 2026-10-15: every grant case read
  // "GrantProposal absent" beside a valid LOI.
  const groups = new Map<string, string[]>();
  for (const e of expected) if (e.alternative) groups.set(e.alternative, [...(groups.get(e.alternative) ?? []), e.iri]);
  for (const members of groups.values()) {
    const winner = members.find((m) => classes[m]?.exists && classes[m]?.valid);
    if (!winner) continue;
    for (const m of members) if (m !== winner && classes[m] && !(classes[m]!.exists && classes[m]!.valid)) classes[m] = { ...classes[m]!, valid: true, errors: [], satisfiedBy: winner };
  }
  return { pass: Object.values(classes).every((c) => (c.exists && c.valid) || c.satisfiedBy), classes, unshaped };
}

/** The shape's fields split the way the judge wants them: required (`minCount ≥ 1`, label excepted) and the rest. */
export function fieldsOfShape(shape: DomainShapeV1 | undefined): { required: string[]; quality: string[] } {
  if (!shape) return { required: [], quality: [] };
  const required = shape.fields.filter((f) => (f.minCount ?? 0) >= 1 && f.name !== 'label').map((f) => f.name);
  const quality = shape.fields.filter((f) => !(f.minCount ?? 0) && f.name !== 'label').map((f) => f.name);
  return { required, quality };
}
