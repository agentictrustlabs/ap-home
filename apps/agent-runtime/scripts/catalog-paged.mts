/**
 * catalog-paged.mts — THE PAGED LIBRARY SWITCH, FOR ONE OWNER (docs/design/library-paged-catalog.md).
 *
 * copy → verify → switch, never move:
 *   prepare     write the pages + an INACTIVE root from the owner's legacy `content.catalog` (the legacy record is untouched)
 *   verify      compare the pages to the legacy record entry by entry (value, key order, order, count)
 *   activate    switch the owner to the pages — only if verify passes NOW and the legacy record is unchanged since prepare
 *   deactivate  the rollback: write the CURRENT pages (saves since the switch included) back into the legacy record,
 *               read it back, verify, and only then switch the owner back
 *   status      what is there (and, mid-rollback, whether the restore landed)
 *   sweep       tombstone page records no root names (a lost collection)
 *
 * deactivate is RESUMABLE: after any failure, run it again.
 *
 * DRY RUN BY DEFAULT: without --execute only `status` is sent (read-only) and the action is printed, not run.
 * `activate --execute` runs `verify` first and refuses unless it passes and the legacy record is unchanged since prepare
 * (the owner's DO checks both again before it switches).
 *
 *   A2A_CUSTODY_BRIDGE_SECRET=… pnpm --filter @ap-home/agent-runtime exec tsx scripts/catalog-paged.mts \
 *     --base https://<agent-runtime host> --owner 0x… --action verify [--execute]
 *
 * The secret is read from the environment and never printed. Exit code 1 on any refusal or failure.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const execute = argv.includes('--execute');
const base = (flag('base') ?? process.env.AGENT_RUNTIME_URL ?? '').replace(/\/+$/, '');
const owner = (flag('owner') ?? '').toLowerCase();
const action = flag('action') ?? 'status';
const secret = process.env.A2A_CUSTODY_BRIDGE_SECRET ?? '';

const ACTIONS = ['status', 'prepare', 'verify', 'activate', 'deactivate', 'sweep'];
if (!base) throw new Error('--base <agent-runtime URL> (or AGENT_RUNTIME_URL) required');
if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new Error('--owner <0x address> required');
if (!ACTIONS.includes(action)) throw new Error(`--action must be one of ${ACTIONS.join(' | ')}`);
if (!secret) throw new Error('A2A_CUSTODY_BRIDGE_SECRET must be set in the environment');

const AUDIENCE = 'custody.library.paged';
async function call(act: string): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ owner, action: act });
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const bodyHash = `0x${createHash('sha256').update(body).digest('hex')}`;
  const signature = createHmac('sha256', secret).update(`${ts}.${nonce}.${bodyHash}.${AUDIENCE}`).digest('hex');
  const res = await fetch(`${base}/custody/library/paged`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-timestamp': ts, 'x-bridge-nonce': nonce, 'x-bridge-audience': AUDIENCE, 'x-bridge-signature': signature },
    body,
  });
  const out = (await res.json().catch(() => ({ ok: false, error: `answered ${res.status} with no JSON` }))) as Record<string, unknown>;
  return { httpStatus: res.status, ...out };
}
const show = (label: string, r: Record<string, unknown>) => console.log(`── ${label} ──\n${JSON.stringify(r, null, 2)}`);

const status = await call('status');
show('status', status);
if (!execute) {
  console.log(`\nDRY RUN — "${action}" was not sent. Re-run with --execute to run it for ${owner}.`);
  process.exit(status.ok === true ? 0 : 1);
}
if (action === 'status') process.exit(status.ok === true ? 0 : 1);

if (action === 'activate') {
  const v = await call('verify');
  show('verify (before activate)', v);
  if (v.ok !== true || v.legacyUnchangedSincePrepare !== true) {
    console.error('\nREFUSED: verify does not pass, or the legacy record changed since prepare — not activating.');
    process.exit(1);
  }
}
const out = await call(action);
show(action, out);
process.exit(out.ok === true ? 0 : 1);
