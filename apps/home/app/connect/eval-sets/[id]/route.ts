export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One baked test set: { id, domain, title, cases, replay, gold, fixtures? } — what Run a comparison submits.
import { EVAL_SETS } from '../../../../src/evals/sets/index';

export const GET = async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const load = EVAL_SETS[id];
  if (!load) return Response.json({ error: `no test set ${id}` }, { status: 404 });
  const mod = await load();
  return Response.json(mod.default, { headers: { 'cache-control': 'public, max-age=300' } });
};
