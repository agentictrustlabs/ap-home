// STREAMABLE HTTP, the streaming half — spec 397 W3. A tools/call whose client accepts `text/event-stream` is answered
// on an SSE stream: progress notifications as the person's agent says what it is doing (its own progress lines, spec
// 370 P2), an elicitation request when the agent asks the person a DATA question and the client can put it to them
// (MCP elicitation, declared at initialize), and finally the result. Nothing here is authority: a signature is never
// elicited — that is a page on the person's Home (grant_link), and the stream says so.

/** One SSE frame carrying a JSON-RPC message. */
export function sseFrame(message: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

export function progressNotification(progressToken: string | number, progress: number, message: string, total?: number): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress, ...(total !== undefined ? { total } : {}), message } };
}

export interface PromptField { name: string; label?: string; type?: string; required?: boolean; hint?: string; options?: Array<{ value: string; label?: string }> }

/** The agent's data prompt as an MCP elicitation: flat, primitive fields only (the standard's shape); a credential or a
 *  signature field is never elicited — those are ceremonies at the person's Home. */
export function elicitationFor(prompt: { prompt?: string; fields?: PromptField[] }): { message: string; requestedSchema: Record<string, unknown> } | null {
  const fields = (prompt.fields ?? []).filter((f) => f.name && f.type !== 'credential' && f.type !== 'signature');
  if (!fields.length) return null;
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    const base: Record<string, unknown> = { title: f.label ?? f.name, ...(f.hint ? { description: f.hint } : {}) };
    if (f.type === 'number' || f.type === 'amount') properties[f.name] = { ...base, type: 'number' };
    else if (f.type === 'boolean' || f.type === 'flag') properties[f.name] = { ...base, type: 'boolean' };
    else if (f.options?.length) properties[f.name] = { ...base, type: 'string', enum: f.options.map((o) => o.value), enumNames: f.options.map((o) => o.label ?? o.value) };
    else properties[f.name] = { ...base, type: 'string' };
  }
  return { message: prompt.prompt ?? 'Your agent needs something from you.', requestedSchema: { type: 'object', properties, required: fields.filter((f) => f.required !== false).map((f) => f.name) } };
}

/** A JSON-RPC RESPONSE message (the client answering a server request) — no method, an id and a result or error. */
export function isJsonRpcResponse(x: unknown): x is { jsonrpc: '2.0'; id: string | number; result?: unknown; error?: unknown } {
  const b = x as { jsonrpc?: unknown; id?: unknown; method?: unknown; result?: unknown; error?: unknown } | null;
  return !!b && b.jsonrpc === '2.0' && typeof b.method !== 'string' && (typeof b.id === 'string' || typeof b.id === 'number') && ('result' in b || 'error' in b);
}
