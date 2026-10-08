// EVAL SETS FROM AN ORGANIZATION'S LIBRARY — the Lab's third source beside the baked sets and an upload (2026-10-08).
// The skills app saves a set as ONE authoring source plus the compiled four (`evaluations/<set>.replay.json`,
// `.gold.json`, `.fixtures.json`, `.outcome-gold.json`) into the domain organization's library, versioned; until now a
// set reached a run only after it was pulled into the skills repo and committed, or re-uploaded by hand. The Lab runs
// in the person's Home with their session, and `/connect/library?org=…&folder=evaluations` hydrates exactly those
// files — so a steward can run what they saved, as saved. Pure: the folder read in, the runnable sets out.
export interface LibraryArtifact { name: string; folder?: string; isFolder?: boolean; bytesB64?: string; version?: number }
export interface LibraryEvalSet {
  id: string;
  title: string;
  cases: number;
  /** The set's version — what the compiled replay carries and the experiment's slate `<set>@<version>` names. */
  version?: string;
  replay: unknown;
  gold: unknown;
  /** The fixtures map (unwrapped from `{ fixtures }`), when the set has starting states. */
  fixtures?: unknown;
}

/** base64 → UTF-8 text (an artifact's bytes). `atob` alone is latin-1 and corrupts an em dash. */
export function utf8FromB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const SUFFIX = { replay: '.replay.json', gold: '.gold.json', fixtures: '.fixtures.json' } as const;

/** The sets a library folder read holds: every `<id>.replay.json` with its `<id>.gold.json` (a replay without gold is not
 *  runnable and is left out); fixtures ride along when present. Sorted by id. An unreadable file drops its set. */
export function parseLibraryEvalSets(artifacts: ReadonlyArray<LibraryArtifact>): LibraryEvalSet[] {
  const files = new Map<string, LibraryArtifact>();
  for (const a of artifacts) if (!a.isFolder && (a.folder ?? '') === 'evaluations' && a.bytesB64) files.set(a.name, a);
  const read = (name: string): unknown => { const a = files.get(name); if (!a?.bytesB64) return undefined; try { return JSON.parse(utf8FromB64(a.bytesB64)); } catch { return undefined; } };
  const out: LibraryEvalSet[] = [];
  for (const name of files.keys()) {
    if (!name.endsWith(SUFFIX.replay)) continue;
    const id = name.slice(0, -SUFFIX.replay.length);
    const replay = read(name) as { title?: unknown; intents?: unknown[]; version?: unknown } | undefined;
    const gold = read(`${id}${SUFFIX.gold}`);
    if (!replay || !gold) continue;
    const fx = read(`${id}${SUFFIX.fixtures}`) as { fixtures?: unknown } | undefined;
    const fixtures = fx && typeof fx === 'object' && 'fixtures' in fx ? fx.fixtures : fx;
    const hasFixtures = !!fixtures && typeof fixtures === 'object' && Object.keys(fixtures as object).length > 0;
    out.push({
      id, title: typeof replay.title === 'string' && replay.title.trim() ? replay.title : id,
      cases: Array.isArray(replay.intents) ? replay.intents.length : 0,
      ...(typeof replay.version === 'string' || typeof replay.version === 'number' ? { version: String(replay.version) } : {}),
      replay, gold, ...(hasFixtures ? { fixtures } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The deep-link form of a library set (`?set=library:<id>`), and its reading. */
export const LIBRARY_SET_PREFIX = 'library:';
export const librarySetParam = (id: string): string => `${LIBRARY_SET_PREFIX}${id}`;
export const librarySetIdOf = (param: string): string | null => (param.startsWith(LIBRARY_SET_PREFIX) ? param.slice(LIBRARY_SET_PREFIX.length) : null);
