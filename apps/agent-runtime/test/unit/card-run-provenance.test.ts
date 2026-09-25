// Spec 414 A1c — every live card declares the run-provenance extension, unconditionally, beside the authority one.
import { describe, expect, it } from 'vitest';
import { RUN_PROVENANCE_EXTENSION_URI } from '@agenticprimitives/a2a';
import { buildA2aAgentCard } from '../../src/host-context.js';

describe('the live card', () => {
  it('declares run-provenance/v1 whether or not the skill-provenance corpus is configured', () => {
    for (const enabled of [false, true]) {
      const card = buildA2aAgentCard({ publicOrigin: 'https://alice.example', agent: '0xb0d11ce19b756a682e78b4904cd8d832303b3d11', name: 'alice.me', label: 'alice-me' } as never, 34348, [], undefined, enabled) as { capabilities: { extensions: Array<{ uri: string }> } };
      expect(card.capabilities.extensions.map((e) => e.uri)).toContain(RUN_PROVENANCE_EXTENSION_URI);
    }
  });
});
