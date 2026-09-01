'use client';
// Recipient view — import an invitation and verify it (spec 338 §5 / §20, W6).
//
// WHY THIS IS CLIENT-SIDE AND NOT A MOCK: the design's central claim is that the RECIPIENT verifies
// independently, so that a compromised resolver cannot substitute an endpoint. Doing that check in
// the recipient's own browser is the architecturally correct place for it, not a shortcut.
//
// WHAT IS VERIFIED HERE (all real, using the Ring-0 functions):
//   • invitation shape + internal bindings (grant target == invitation target == expected binding)
//   • the carried publication's DIGEST, recomputed from its canonical body — catches any tampering
//   • freshness: expiry, status, sequence
//
// WHAT IS **NOT** VERIFIED HERE (stated in the UI, not buried):
//   • the SIGNATURE. That needs an on-chain ERC-1271 read, which this browser pane does not perform.
//     A digest match proves the bytes were not altered after signing; it does NOT prove who signed.
//
// The single most important line this pane renders is the last one: authorization is NOT granted.

import { useCallback, useState } from 'react';
import type { AgentConnectionInvitationV1 } from '@agenticprimitives/agent-resolution';
import {
  AUTHORIZATION_NOT_GRANTED,
  inspectInvitation,
  type CheckState,
  type InvitationCheck,
} from '../../../lib/invitation-check';
import { Card, Row, Stack } from '../../shared/ui';
import { BusyButton } from '../../shared/BusyButton';

function Mark({ state }: { state: CheckState }) {
  const map: Record<CheckState, { glyph: string; color: string; label: string }> = {
    pass: { glyph: '✓', color: 'var(--success, #1e7a3c)', label: 'verified' },
    fail: { glyph: '✕', color: 'var(--danger, #b3261e)', label: 'failed' },
    unchecked: { glyph: '–', color: 'var(--muted, #8a8578)', label: 'not checked here' },
  };
  const m = map[state];
  return (
    <span aria-label={m.label} title={m.label} style={{ color: m.color, fontWeight: 700, width: '1rem', display: 'inline-block' }}>
      {m.glyph}
    </span>
  );
}

export function InvitationInspector() {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<AgentConnectionInvitationV1 | null>(null);
  const [checks, setChecks] = useState<InvitationCheck[] | null>(null);
  const [failed, setFailed] = useState(false);

  const inspect = useCallback(async () => {
    setBusy(true);
    setError(null);
    setChecks(null);
    setInvitation(null);
    try {
      // All verification lives in `lib/invitation-check` — pure, tested, and reusable server-side.
      const result = await inspectInvitation(raw);
      setInvitation(result.invitation);
      setChecks(result.checks);
      setFailed(result.failed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [raw]);

  return (
    <Card>
      <Stack gap={0.75}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Check an invitation</h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', opacity: 0.75 }}>
            Paste an invitation someone sent you. Everything is checked in your browser — you are not
            asked to trust the sender&apos;s server, which is the point.
          </p>
        </div>

        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder='{"specVersion":"ap.agent-connection-invitation/1", …}'
          rows={6}
          spellCheck={false}
          aria-label="Invitation JSON"
          style={{
            width: '100%',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '0.78rem',
            padding: '0.5rem',
            borderRadius: 8,
            border: '1px solid var(--border, #e4e0d8)',
            resize: 'vertical',
          }}
        />

        <Row gap={0.5}>
          <BusyButton busy={busy} busyLabel="Checking…" onClick={inspect} disabled={!raw.trim()}>
            Check invitation
          </BusyButton>
          {(checks || error) && (
            <button
              type="button"
              onClick={() => {
                setRaw('');
                setChecks(null);
                setInvitation(null);
                setError(null);
              }}
              style={{ background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.8rem', color: 'var(--color-text-body)' }}
            >
              Clear
            </button>
          )}
        </Row>

        {error && (
          <div role="alert" style={{ fontSize: '0.85rem', color: 'var(--danger, #b3261e)' }}>
            {error}
          </div>
        )}

        {invitation && checks && (
          <Stack gap={0.6}>
            <Stack gap={0.2} style={{ fontSize: '0.85rem' }}>
              <Row justify="space-between">
                <span style={{ opacity: 0.7 }}>Agent</span>
                <code style={{ fontSize: '0.75rem' }}>{invitation.targetAgent}</code>
              </Row>
              {invitation.display?.label && (
                <Row justify="space-between">
                  <span style={{ opacity: 0.7 }}>Shown to you as</span>
                  <span>{invitation.display.label}</span>
                </Row>
              )}
              {invitation.display?.purpose && (
                <Row justify="space-between">
                  <span style={{ opacity: 0.7 }}>Purpose</span>
                  <span>{invitation.display.purpose}</span>
                </Row>
              )}
              <Row justify="space-between">
                <span style={{ opacity: 0.7 }}>Invited by</span>
                <code style={{ fontSize: '0.75rem' }}>{invitation.issuer}</code>
              </Row>
            </Stack>

            <Stack gap={0.3}>
              {checks.map((c) => (
                <Row key={c.id} gap={0.4} style={{ alignItems: 'flex-start', fontSize: '0.82rem' }}>
                  <Mark state={c.state} />
                  <div>
                    <div>{c.label}</div>
                    {c.detail && <div style={{ opacity: 0.7, fontSize: '0.76rem' }}>{c.detail}</div>}
                  </div>
                </Row>
              ))}
            </Stack>

            {/* THE LINE THAT MATTERS. Resolution is not authority — a recipient who reads only one
                sentence on this page should read this one. */}
            <div
              style={{
                padding: '0.6rem 0.75rem',
                borderRadius: 8,
                border: '1px solid var(--border, #e4e0d8)',
                background: 'var(--surface-alt, rgba(0,0,0,0.03))',
                fontSize: '0.82rem',
              }}
            >
              <strong>Permission to use this agent: not granted.</strong>
              <div style={{ opacity: 0.78, marginTop: '0.2rem' }}>{AUTHORIZATION_NOT_GRANTED}</div>
            </div>

            {failed && (
              <div role="alert" style={{ fontSize: '0.82rem', color: 'var(--danger, #b3261e)' }}>
                One or more checks failed. Do not connect using these details.
              </div>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
