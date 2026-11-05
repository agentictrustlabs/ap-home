// What the Home's server talks to, faked, so the real production build can run with no live estate: an in-memory KV that
// speaks the Upstash REST protocol, and a JSON-RPC chain whose answers a test can change. Nothing here spends anything.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { encodeAbiParameters, toFunctionSelector } from 'viem';

const kv = new Map();
const chain = { revoked: new Set(), invalidSignature: false, down: false, revocationDown: false, name: '' };
const IS_REVOKED = toFunctionSelector('isRevoked(bytes32)');
const IS_VALID = '0x1626ba7e';
const REVERSE = toFunctionSelector('reverseResolveString(address)');
const word = (hex) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;
const factory = (process.env.FAKE_FACTORY ?? '').toLowerCase();

function redis([cmd, ...a]) {
  switch (String(cmd).toUpperCase()) {
    case 'GET': return kv.get(a[0]) ?? null;
    case 'SET': kv.set(a[0], String(a[1])); return 'OK';
    case 'DEL': return kv.delete(a[0]) ? 1 : 0;
    case 'SCAN': { const m = String(a[a.indexOf('match') + 1] ?? a[a.indexOf('MATCH') + 1] ?? '*').replace(/\*$/, ''); return ['0', [...kv.keys()].filter((k) => k.startsWith(m))]; }
    default: return null;
  }
}
const encode = (v) => (typeof v === 'string' && v !== 'OK' ? Buffer.from(v).toString('base64') : Array.isArray(v) ? v.map(encode) : v);

function rpc({ method, params }) {
  if (method === 'eth_chainId') return '0x862c';
  if (method === 'eth_getCode') return '0x60';
  if (method === 'eth_blockNumber') return '0x1';
  if (method !== 'eth_call') return null;
  const { to, data = '0x', input } = params[0];
  const d = input ?? data;
  if (d.startsWith(REVERSE)) return encodeAbiParameters([{ type: 'string' }], [chain.name]); // '' for an account with no handle, as the real resolver answers
  if (d.startsWith(IS_REVOKED)) return word(chain.revoked.has(`0x${d.slice(10)}`.toLowerCase()) ? '1' : '0');
  if (d.startsWith(IS_VALID)) return chain.invalidSignature ? word('0') : '0x1626ba7e'.padEnd(66, '0');
  // The account factory: a stable account per custodian.
  if (to?.toLowerCase() === factory) return word(createHash('sha256').update(d).digest('hex').slice(0, 40));
  return word('1');
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  const body = text ? JSON.parse(text) : null;
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
  const send = (o, s = 200) => { res.writeHead(s, cors); res.end(JSON.stringify(o)); };
  if (req.method === 'OPTIONS') return send({});
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/kv')) {
    const b64 = req.headers['upstash-encoding'] === 'base64';
    if (pathname.includes('pipeline') || pathname.includes('multi')) return send(body.map((c) => ({ result: b64 ? encode(redis(c)) : redis(c) })));
    const r = redis(body);
    return send({ result: b64 ? encode(r) : r });
  }
  if (pathname === '/rpc') {
    if (chain.down) return send({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'chain down' } });
    if (chain.revocationDown && body.params?.[0]?.data?.startsWith(IS_REVOKED)) return send({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'chain down' } });
    const one = (q) => ({ jsonrpc: '2.0', id: q.id, result: rpc(q) });
    return send(Array.isArray(body) ? body.map(one) : one(body));
  }
  // The tests' own handles.
  if (pathname === '/__kv/get') return send({ value: kv.get(new URL(req.url, 'http://x').searchParams.get('key')) ?? null });
  if (pathname === '/__kv/put') { kv.set(body.key, body.value); return send({ ok: true }); }
  if (pathname === '/__kv/del') { kv.delete(body.key); return send({ ok: true }); }
  if (pathname === '/__kv/keys') return send({ keys: [...kv.keys()].filter((k) => k.startsWith(body?.prefix ?? '')) });
  if (pathname === '/__chain') {
    if (body.revoke) chain.revoked.add(body.revoke.toLowerCase());
    if (body.reset) { chain.revoked.clear(); chain.invalidSignature = false; chain.down = false; chain.revocationDown = false; chain.name = ''; }
    if ('invalidSignature' in body) chain.invalidSignature = body.invalidSignature;
    if ('down' in body) chain.down = body.down;
    if ('revocationDown' in body) chain.revocationDown = body.revocationDown;
    if ('name' in body) chain.name = body.name;
    return send({ ok: true });
  }
  return send({ error: 'no' }, 404);
}).listen(Number(process.env.PORT ?? 8799), '127.0.0.1');
