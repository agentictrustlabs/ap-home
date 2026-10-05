import { describe, expect, it } from 'vitest';
import { originHeaders } from '../src/index';

// The pair is what the gateway presents TO its origin. Three cases matter: both set (sent), neither set
// (not sent — a VNet-private origin needs no second factor), and one of the two set (not sent — a half
// pair is a misconfiguration, and sending one header would let an origin that checks only the id pass).
describe('originHeaders', () => {
  it('sends the Cloudflare Access service-token pair when both secrets are set', () => {
    const h = originHeaders({ ORIGIN_CLIENT_ID: 'id-1', ORIGIN_CLIENT_SECRET: 'sec-1' });
    expect(h['content-type']).toBe('application/json');
    expect(h['CF-Access-Client-Id']).toBe('id-1');
    expect(h['CF-Access-Client-Secret']).toBe('sec-1');
  });

  it('sends only content-type when the pair is unset', () => {
    expect(originHeaders({})).toEqual({ 'content-type': 'application/json' });
  });

  it('treats a half pair as unset', () => {
    expect(originHeaders({ ORIGIN_CLIENT_ID: 'id-only' })).toEqual({ 'content-type': 'application/json' });
    expect(originHeaders({ ORIGIN_CLIENT_SECRET: 'sec-only' })).toEqual({ 'content-type': 'application/json' });
  });
});
