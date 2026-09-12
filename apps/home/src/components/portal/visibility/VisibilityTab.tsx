'use client';
// Manage → Visibility (spec 338 §20, W6).
//
// Two audiences on one page, as sub-tabs:
//   • "This agent"  — the owner: posture + the invitations they issued.
//   • "Check an invitation" — the recipient: paste, verify locally, see what it does and does NOT grant.
//
// The recipient side is not a courtesy feature. Independent client-side verification is the property
// that makes a compromised lookup service survivable, so the Home is exactly where it belongs.

import { useState } from 'react';
import type { AgentDiscoveryPreset } from '@agenticprimitives/agent-resolution';
import { Stack } from '../../shared/ui';
import { VisibilityPolicyCard } from './VisibilityPolicyCard';
import { InvitationsPanel } from './InvitationsPanel';
import { DiscoveryAuthorityPanel } from './DiscoveryAuthorityPanel';
import { InvitationInspector } from './InvitationInspector';

type Pane = 'agent' | 'inspect';

export function VisibilityTab() {
  const [pane, setPane] = useState<Pane>('agent');
  // Local until the owner vault is wired (spec 338 W3-d) — see InvitationsPanel's status note.
  const [preset, setPreset] = useState<AgentDiscoveryPreset>('public-commercial');

  return (
    <Stack gap={1}>
      <div role="tablist" aria-label="Visibility" className="ui-tabs">
        {(
          [
            ['agent', 'This agent'],
            ['inspect', 'Check an invitation'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={pane === id}
            onClick={() => setPane(id)}
            className="ui-tab"
          >
            {label}
          </button>
        ))}
      </div>

      {pane === 'agent' ? (
        <Stack gap={1}>
          <VisibilityPolicyCard value={preset} onChange={setPreset} />
          {/* The Settings nav links straight here (`/visibility#invitations`). Without the anchor the
              link lands on the page and does nothing visible, which reads as a broken menu item. */}
          <div id="invitations"><InvitationsPanel /></div>
          <DiscoveryAuthorityPanel />
        </Stack>
      ) : (
        <InvitationInspector />
      )}
    </Stack>
  );
}
