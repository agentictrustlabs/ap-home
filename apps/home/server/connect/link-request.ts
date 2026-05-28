// POST /connect/link/request — a NEW device posts its freshly-created passkey
// (PUBLIC key only) + the target agent; we stash it under a short single-use code
// (KV, 10-min TTL) for the ORIGINAL device to look up + approve (spec 233 P2).
// Stored data is all public (pubkey x/y + digest + agent); the code is just a
// lookup capability — approving still requires the ROOT passkey on the other
// device, so a leaked code cannot enroll anything.
import { json, type FnContext } from '../_lib/server-broker';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^[0-9]{1,78}$/;

function genCode(): string {
  // 6 chars, unambiguous alphabet (no 0/O/1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, (b) => alphabet[b % alphabet.length]).join('');
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | { agent?: string; name?: string; credentialIdDigest?: string; x?: string; y?: string; label?: string }
    | null;
  if (!body) return json({ error: 'invalid body' }, 400);
  const { agent, name, credentialIdDigest, x, y } = body;
  if (!agent || !ADDR.test(agent)) return json({ error: 'valid agent address required' }, 400);
  if (!name || typeof name !== 'string') return json({ error: 'name required' }, 400);
  if (!credentialIdDigest || !B32.test(credentialIdDigest)) return json({ error: 'valid credentialIdDigest required' }, 400);
  if (!x || !UINT.test(x) || !y || !UINT.test(y)) return json({ error: 'valid pubkey x,y required' }, 400);

  const code = genCode();
  const label = typeof body.label === 'string' ? body.label.slice(0, 64) : 'New device';
  await env.AUTH_CODES.put(
    `linkreq:${code}`,
    JSON.stringify({ agent, name, credentialIdDigest, x, y, label }),
    { expirationTtl: 600 },
  );
  return json({ code });
};
