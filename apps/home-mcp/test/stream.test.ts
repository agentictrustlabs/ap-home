// Spec 397 W3 — the stream helpers: frames, progress, elicitation shape (never a credential or signature field), responses.
import { describe, it, expect } from 'vitest';
import { sseFrame, progressNotification, elicitationFor, isJsonRpcResponse } from '../src/stream.js';

describe('stream helpers', () => {
  it('frames a message as one SSE event', () => {
    expect(sseFrame({ a: 1 })).toBe('event: message\ndata: {"a":1}\n\n');
    expect(sseFrame({ a: 1 }, '7')).toBe('id: 7\nevent: message\ndata: {"a":1}\n\n');
  });
  it('shapes a progress notification', () => {
    expect(progressNotification('t1', 2, 'asking Ligonier…')).toEqual({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 't1', progress: 2, message: 'asking Ligonier…' } });
  });
  it('turns a data prompt into an elicitation and drops credential/signature fields', () => {
    const e = elicitationFor({ prompt: 'Which item?', fields: [{ name: 'id', label: 'Item id', required: true }, { name: 'cred', type: 'credential' }, { name: 'ok', type: 'boolean', required: false }] });
    expect(e?.message).toBe('Which item?');
    expect(Object.keys((e?.requestedSchema as { properties: Record<string, unknown> }).properties)).toEqual(['id', 'ok']);
    expect((e?.requestedSchema as { required: string[] }).required).toEqual(['id']);
    expect(elicitationFor({ prompt: 'sign', fields: [{ name: 's', type: 'signature' }] })).toBeNull();
  });
  it('recognises a JSON-RPC response and not a request', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 'elicit-1', result: { action: 'accept', content: {} } })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toBe(false);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(false);
  });
});
