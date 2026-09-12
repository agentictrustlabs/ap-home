/**
 * Spec 398 §4.5 / T18 — THE INVITATION AUDIT: a scanner's GET never mutates. Every `/connect/*invite*` route redeems
 * by POST only; a GET may exist only as a READ (the lookup that turns a link into where to go) and its server module
 * must call no mutating vault op; redemption checks expiry and binds the recipient. Static, fast, part of check:all.
 *
 *   npx tsx scripts/check-invitation-audit.mts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP = 'apps/demo-sso-next';
const routes: string[] = [];
const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n === 'route.ts' && /invite/.test(p)) routes.push(p); } };
walk(join(APP, 'app', 'connect'));
const failures: string[] = [];
const READ_ONLY_GETS = new Set(['app/connect/org-invite/lookup/route.ts']);
const MUTATING = /\b(vault|store|kv)\.(put|set|delete|remove|write)\(|\.put\(`org\.invite|redeem\(|consume\(/;
for (const r of routes) {
  const src = readFileSync(r, 'utf8');
  const methods = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!);
  const rel = r.replace(`${APP}/`, '');
  if (methods.includes('GET') && !READ_ONLY_GETS.has(rel)) failures.push(`${rel}: exports GET — an invitation route redeems by POST only (T18)`);
  if (methods.includes('GET')) {
    // the GET's server module: read-only by inspection
    const mod = src.match(/from '((?:\.\.\/)+server\/connect\/[\w-]+)'/)?.[1];
    if (mod) {
      const modPath = join(r, '..', `${mod}.ts`);
      const body = readFileSync(modPath, 'utf8');
      const getFn = body.slice(body.indexOf('onRequestGet'));
      if (MUTATING.test(getFn)) failures.push(`${rel}: its GET handler (${mod}) calls a mutating op`);
    }
  }
  if (/redeem/.test(rel)) {
    const mod = src.match(/from '((?:\.\.\/)+server\/connect\/[\w-]+)'/)?.[1];
    const body = mod ? readFileSync(join(r, '..', `${mod}.ts`), 'utf8') : '';
    if (!/expiresAt/.test(body)) failures.push(`${rel}: redemption does not check expiry`);
    if (!/emailHash|delegate|recipient|memberAddress/.test(body)) failures.push(`${rel}: redemption is not recipient-bound`);
  }
}
if (failures.length) { console.error(`✗ check:invitation-audit — ${failures.length} finding(s):\n${failures.map((f) => `  · ${f}`).join('\n')}`); process.exit(1); }
console.log(`✓ check:invitation-audit passed (${routes.length} invitation routes: POST-only redemption, the one GET a read, expiry + recipient binding on redeem).`);
