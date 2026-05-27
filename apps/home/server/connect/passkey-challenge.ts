// GET /connect/passkey-challenge → a single-use 32-byte hex challenge (KV, 5-min).
// The browser signs it via WebAuthn; /connect/passkey verifies proof-of-possession.
import { json, type FnContext } from '../_lib/server-broker';

export const onRequestGet = async ({ env }: FnContext): Promise<Response> => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  await env.AUTH_CODES.put(`pkchallenge:${hex}`, '1', { expirationTtl: 300 });
  return json({ challenge: hex });
};
