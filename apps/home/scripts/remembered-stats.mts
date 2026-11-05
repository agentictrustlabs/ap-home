// Spec 445 W0/W3 — how the remembered-consent decisions are going, by day, client, mode and outcome. Read-only.
//   pnpm --filter @ap-home/home exec tsx scripts/remembered-stats.mts [days]    (needs the Home's KV env)
// Counts are approximate (KV has no increment): good for "is this working", not for billing.
import { kv } from '../app/_lib/kv';

const days = Number(process.argv[2] ?? 7);
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const totals = new Map<string, number>();
let cursor: string | undefined;
do {
  const page = await kv.list({ prefix: 'remembered-stat:', cursor });
  for (const { name } of page.keys) {
    const [, day, clientId, mode, outcome] = name.split(':');
    if (!day || day < since) continue;
    const k = `${clientId}\t${mode}\t${outcome}`;
    totals.set(k, (totals.get(k) ?? 0) + Number((await kv.get(name)) ?? 0));
  }
  cursor = page.list_complete ? undefined : page.cursor;
} while (cursor);
console.log(`since ${since}\nclient\tmode\toutcome\tcount`);
for (const [k, n] of [...totals].sort()) console.log(`${k}\t${n}`);
