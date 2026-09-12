// THE HOME COMPONENT REGISTRY — spec 398 §10.5. shadcn-compatible: `/registry` is the index, `/registry/<name>.json`
// one item with its files inline, the contract it expects and an executable example. Read-only, public, generated
// from this app's own components by Ring 0's build-component-registry (drift is a gate). Installing a component never
// installs authority (D07): an item carries no key, no grant, no verb.
import registry from '../../../src/registry/registry.json';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });

export async function GET(_req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const path = (await ctx.params).path ?? [];
  const items = (registry as { items: Array<{ name: string; files: Array<{ path: string; type: string; content: string }> }> }).items;
  if (path.length === 0 || (path.length === 1 && path[0] === 'index.json')) {
    // the index lists files without their content; an item carries them
    return json({ ...registry, items: items.map((it) => ({ ...it, files: it.files.map(({ path: p, type }) => ({ path: p, type })) })) });
  }
  if (path.length === 1) {
    const name = path[0]!.replace(/\.json$/, '');
    const item = items.find((it) => it.name === name);
    if (item) return json({ $schema: 'https://ui.shadcn.com/schema/registry-item.json', ...item });
  }
  return json({ error: 'no such registry item', items: items.map((it) => it.name) }, 404);
}
