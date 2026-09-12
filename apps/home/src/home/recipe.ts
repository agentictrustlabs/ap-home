// SAVE AS RECIPE — spec 398 §5 / APUX-034 (G3), the Home half. The runtime drafts (from the record and the playbook, never
// a key); the person SAVES, into the Library of the workspace the run belonged to, as a `skill` artifact (a SKILL.md
// package, ADR-0051) under `recipes/`. The Library entry is a Library artifact like any other: versioned, shareable,
// publishable (398 §6.2) — and assigning it to an agent asks for authority anew, which the draft itself says.
import type { RecipeDraft } from './ask';

export interface RecipeSaveTarget {
  /** `/connect/library` scope: the org's Library when the run was an organization's, else the person's own. */
  scopeQuery: string;
  folder: 'recipes';
  artifact: { name: string; kind: 'skill'; source: 'blob'; folder: 'recipes'; contentType: 'text/markdown'; bytesB64: string };
  /** Where the saved artifact opens. */
  libraryHref: string;
}

const b64 = (s: string): string => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64'));

/** Where and as what the draft is saved — pure, so the target is testable without a Library. */
export function recipeSaveTarget(recipe: Pick<RecipeDraft, 'fileName' | 'skillMd'>, scope: { kind: 'person' } | { kind: 'org'; org: string } | { kind: 'service'; agent: string }): RecipeSaveTarget {
  const org = scope.kind === 'org' ? scope.org.toLowerCase() : scope.kind === 'service' ? scope.agent.toLowerCase() : null;
  return {
    scopeQuery: org ? `?org=${org}` : '',
    folder: 'recipes',
    artifact: { name: recipe.fileName, kind: 'skill', source: 'blob', folder: 'recipes', contentType: 'text/markdown', bytesB64: b64(recipe.skillMd) },
    libraryHref: `${org ? (scope.kind === 'org' ? `/org/${org}/library` : `/service/${org}/library`) : '/library'}?folder=recipes`,
  };
}

/** The sentence the affordance shows before saving: what the draft holds and what it does not. */
export function recipeSummary(r: RecipeDraft): string {
  const roles = r.roles.length ? `${r.roles.length} role${r.roles.length === 1 ? '' : 's'} (${r.roles.map((x) => `{${x.role}}`).join(', ')})` : 'no roles';
  return `${r.steps.length} step${r.steps.length === 1 ? '' : 's'} · ${r.capabilities.length} capabilit${r.capabilities.length === 1 ? 'y' : 'ies'} · ${roles} · no keys, no mandates — authority is asked for anew when it is assigned`;
}
