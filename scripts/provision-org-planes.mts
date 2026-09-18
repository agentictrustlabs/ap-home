// Turn on an org's INTERACTIONS and inbox-DELIVERY planes, signed by its custodian's EOA.
//
// WHY THIS EXISTS. `PUT /connect/demo-provision` at the Home does the same job and needs
// `DEMO_SIGNER_SECRET` — a Vercel env var, not present in this repo. But the secret is only how the
// HOME gets a signature; the authority underneath is the org SA's ERC-1271 accepting its custodian's
// EOA, and the demo custodians' keys ARE in this repo (`demo/personas.json`). So a script holding the
// custodian key can mint the identical grants with no Home secret and no browser — exactly the
// argument `reissue-interactions-grant.mts` already makes for the interactions plane.
//
// TWO PLANES, AND THE SECOND IS THE ONE THAT BITES. `/grant` carries the interactions plane (inbox
// index, board, directory, channels). `grant.delivery.put` carries the write-only delivery wire where
// message bodies and ARTIFACTS live. An org with the first and not the second passes most health
// checks and then answers 503 "organization storage not enabled" on the first artifact write — which
// is precisely how Missio Nexus looked activated while field records were being refused.
//
// THE DELIVERY DELEGATE. demo-a2a pins it to `DELIVERY_SERVICE_SA` when that is configured and skips
// the check when it is not (NEW-H6, "inert until provisioned"). It is not configured on the live
// worker, so the interactions service SA is used for both. If that pin is ever switched on, this
// script must be given the real delivery SA rather than quietly failing the 403.
//
//   npx tsx scripts/provision-org-planes.mts --org "Missio Nexus" --custodian alice [--dry-run]
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import {
  issueInboxDeliveryDelegation,
  issueInteractionsDelegation,
  issueSessionDelegation,
  toWire,
} from '../apps/demo-sso-next/src/lib/delegation.js';
import { MCP_SERVER_ID } from '../apps/demo-sso-next/src/lib/inbox-delivery.js';

const A2A = process.env.A2A_BASE ?? 'https://demo-a2a-production.richardpedersen3.workers.dev';
const INTERACTIONS_SERVICE_SA = (process.env.INTERACTIONS_SERVICE_SA
  ?? '0x39508624387fed3b9d6dd15ba86d3ace8a3f0a6a') as Address;
const DELIVERY_SERVICE_SA = (process.env.DELIVERY_SERVICE_SA ?? INTERACTIONS_SERVICE_SA) as Address;
const PERSONAS = process.env.PERSONAS ?? new URL('../demo/personas.json', import.meta.url).pathname;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
/**
 * Re-sign a plane that already reports on.
 *
 * `granted: true` says a grant is STORED, not that it is usable — a grant written without the DEL-001
 * session leaf reports granted and then 409s every vault op. The idempotency check short-circuited
 * exactly the re-sign that would have added the leaf, so repairing it needs an explicit override.
 */
const FORCE = args.includes('--force');
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const ORG_NAME = arg('--org') ?? 'Missio Nexus';
const CUSTODIAN = arg('--custodian') ?? 'alice';

type Persona = { name: string; sa: string; eoaPrivateKey: string; custodies?: { sa: string; name: string }[] };
const people = JSON.parse(readFileSync(PERSONAS, 'utf8')) as Record<string, Persona>;

const person = people[CUSTODIAN];
if (!person?.eoaPrivateKey) throw new Error(`no key for "${CUSTODIAN}" in ${PERSONAS}`);
const orgSA = person.custodies?.find((c) => c.name === ORG_NAME)?.sa as Address | undefined;
if (!orgSA) throw new Error(`${CUSTODIAN} does not custody an org named "${ORG_NAME}"`);

/** The org SA's ERC-1271 accepts its custodian's EOA. That is the whole authority here. */
const signHash = async (digest: Hex): Promise<Hex> =>
  privateKeyToAccount(person.eoaPrivateKey as Hex).signMessage({ message: { raw: digest } });

const status = async () =>
  (await (await fetch(`${A2A}/interactions/${orgSA.toLowerCase()}/status`)).json().catch(() => ({}))) as {
    granted?: boolean;
    deliveryGranted?: boolean;
  };

const post = async (op: string, body: unknown): Promise<void> => {
  const res = await fetch(`${A2A}/interactions/${orgSA.toLowerCase()}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || out.ok !== true) throw new Error(`${op}: ${out.error ?? `HTTP ${res.status}`}`);
};

async function main(): Promise<void> {
  console.log(`${ORG_NAME}  ${orgSA}`);
  console.log(`custodian: ${person.name}   interactions: ${INTERACTIONS_SERVICE_SA}   delivery: ${DELIVERY_SERVICE_SA}\n`);

  const before = await status();
  console.log(`before: granted=${before.granted === true}  deliveryGranted=${before.deliveryGranted === true}`);
  if (!FORCE && before.granted === true && before.deliveryGranted === true) {
    console.log('both planes already on — nothing to do.');
    return;
  }
  if (DRY) {
    console.log('\n(dry run — nothing written)');
    return;
  }

  if (FORCE || before.granted !== true) {
    const d = await issueInteractionsDelegation(orgSA, INTERACTIONS_SERVICE_SA, MCP_SERVER_ID, signHash);

    // THE DEL-001 SESSION LEAF, and it is not optional in practice.
    //
    // The grant alone stores fine and then every vault op through the DO answers 409
    // `session_leaf_required`: server-mint was retired (CRIT-2), so the DO can only mint bound tokens
    // when the PRINCIPAL has custodied a leaf to the interactions-session key. The browser ceremony
    // always sends one; a grant written without it looks enabled and is not.
    const sk = (await (await fetch(`${A2A}/agent/interactions-session-key`)).json().catch(() => ({}))) as {
      ok?: boolean;
      address?: string;
    };
    if (!sk?.ok || !/^0x[0-9a-fA-F]{40}$/.test(sk.address ?? '')) {
      throw new Error('no interactions-session key advertised — the grant would store and every vault op would 409');
    }
    const leaf = await issueSessionDelegation(orgSA, sk.address as Address, signHash, [INTERACTIONS_SERVICE_SA, DELIVERY_SERVICE_SA]); // spec 408 §2.1
    await post('grant', { delegation: toWire(d), sessionLeaf: toWire(leaf) });
    console.log(`  ✓ interactions plane (+ session leaf → ${sk.address!.slice(0, 10)}…)`);
  }
  if (FORCE || before.deliveryGranted !== true) {
    const d = await issueInboxDeliveryDelegation(orgSA, DELIVERY_SERVICE_SA, MCP_SERVER_ID, signHash);
    await post('grant.delivery.put', { delegation: toWire(d) });
    console.log('  ✓ delivery plane');
  }

  // The DO is the authority on whether a plane is on, not the response to the write that set it.
  const after = await status();
  console.log(`\nafter:  granted=${after.granted === true}  deliveryGranted=${after.deliveryGranted === true}`);
  if (after.deliveryGranted !== true) {
    console.error('delivery plane still off — artifact writes will keep answering 503.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
