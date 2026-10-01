export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The Lab's test sets, as baked by scripts/bake-eval-sets.mts: the manifest (ids, titles, case counts, which is
// recommended). Data only — authored test sentences and their gold, nobody's words; no session needed.
import manifest from '../../../src/evals/sets/manifest.json';

export const GET = () => Response.json(manifest, { headers: { 'cache-control': 'public, max-age=300' } });
