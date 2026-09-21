import { describe, it, expect } from 'vitest';
import { scopedActionTools } from '../src/harness-run.js';

describe('every offered tool schema is valid JSON Schema for every provider', () => {
  it('names in `required` are properties the schema declares', () => {
    // Gemini validates this and refused the whole vocabulary for one stale name (2026-09-20);
    // Anthropic and xAI tolerated it, which is how it survived. A required name nobody declares
    // cannot be supplied and cannot be asked for by its own label.
    const bad: string[] = [];
    for (const t of scopedActionTools()) {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: readonly string[] } | undefined;
      const props = Object.keys(schema?.properties ?? {});
      for (const r of schema?.required ?? []) if (!props.includes(r)) bad.push(`${t.id}: ${r}`);
    }
    expect(bad).toEqual([]);
  });
});
