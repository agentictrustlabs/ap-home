'use client';
// Owner administration — the invitations you have issued (spec 338 §20, W6).
//
// STATUS: this pane is deliberately READ-ONLY and locally-scoped. Issuing a real grant requires the
// owner vault (authoritative store) plus a deployed rendezvous resolver, neither of which is wired to
// this Home yet (spec 338 W3-d). Rather than fake an "Issue invitation" button that writes nowhere,
// this shows the shape an owner manages and states plainly what is not connected.
//
// The columns are chosen from spec 338 §20's owner-administration list: recipient, projection
// profile, expiry, status, latest publication, and the two independent revocations — because the
// thing an owner most needs to understand is that revoking DISCOVERY and revoking USE are different
// buttons with different consequences.

import { Card, Row, Stack } from '../../shared/ui';

/** What the Home would render per issued invitation. Shapes mirror spec 338 §4/§5. */
export interface InvitationSummary {
  invitationId: string;
  /** The label THIS recipient sees. Never shared across recipients (pairwise unlinkability). */
  privateLabel?: string;
  recipient?: string;
  purpose?: string;
  projectionProfile: string;
  expiresAt: string;
  status: 'active' | 'revoked' | 'expired';
  latestPublicationSequence?: string;
  resolutionsUsed?: number;
  maximumResolutions?: number;
}

function StatusPill({ status }: { status: InvitationSummary['status'] }) {
  const tone =
    status === 'active'
      ? { bg: 'rgba(30,122,60,0.12)', fg: 'var(--success, #1e7a3c)' }
      : status === 'revoked'
        ? { bg: 'rgba(179,38,30,0.12)', fg: 'var(--danger, #b3261e)' }
        : { bg: 'rgba(0,0,0,0.06)', fg: 'var(--muted, #6b6659)' };
  return (
    <span style={{ background: tone.bg, color: tone.fg, borderRadius: 999, padding: '0.1rem 0.5rem', fontSize: '0.72rem', fontWeight: 600 }}>
      {status}
    </span>
  );
}

export function InvitationsPanel({ invitations = [] }: { invitations?: InvitationSummary[] }) {
  return (
    <Card>
      <Stack gap={0.75}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Invitations you&apos;ve issued</h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', opacity: 0.75 }}>
            Each invitation lets one party discover how to reach this agent. Each one is revocable on its
            own, and revoking it does <em>not</em> revoke any permission you granted them.
          </p>
        </div>

        {invitations.length === 0 ? (
          <div style={{ fontSize: '0.85rem', opacity: 0.75 }}>
            No invitations issued.
          </div>
        ) : (
          <Stack gap={0.4}>
            {invitations.map((inv) => (
              <div
                key={inv.invitationId}
                style={{ border: '1px solid var(--border, #e4e0d8)', borderRadius: 8, padding: '0.6rem 0.75rem' }}
              >
                <Row justify="space-between" wrap>
                  <strong style={{ fontSize: '0.88rem' }}>{inv.privateLabel ?? inv.invitationId}</strong>
                  <StatusPill status={inv.status} />
                </Row>
                <Stack gap={0.15} style={{ fontSize: '0.78rem', opacity: 0.8, marginTop: '0.3rem' }}>
                  {inv.recipient && (
                    <Row justify="space-between">
                      <span>Recipient</span>
                      <code style={{ fontSize: '0.72rem' }}>{inv.recipient}</code>
                    </Row>
                  )}
                  {inv.purpose && (
                    <Row justify="space-between">
                      <span>Purpose</span>
                      <span>{inv.purpose}</span>
                    </Row>
                  )}
                  <Row justify="space-between">
                    <span>They can see</span>
                    <span>{inv.projectionProfile}</span>
                  </Row>
                  <Row justify="space-between">
                    <span>Expires</span>
                    <span>{new Date(inv.expiresAt).toLocaleDateString()}</span>
                  </Row>
                  {inv.latestPublicationSequence !== undefined && (
                    <Row justify="space-between">
                      <span>Service details version</span>
                      <span>#{inv.latestPublicationSequence}</span>
                    </Row>
                  )}
                  {inv.maximumResolutions !== undefined && (
                    <Row justify="space-between">
                      <span>Lookups used</span>
                      <span>
                        {inv.resolutionsUsed ?? 0} / {inv.maximumResolutions}
                      </span>
                    </Row>
                  )}
                </Stack>
              </div>
            ))}
          </Stack>
        )}

        <div
          style={{
            padding: '0.6rem 0.75rem',
            borderRadius: 8,
            border: '1px dashed var(--border, #e4e0d8)',
            fontSize: '0.8rem',
            opacity: 0.85,
          }}
        >
          <strong>Not connected yet.</strong>
          <div style={{ marginTop: '0.2rem' }}>
            Issuing and revoking invitations needs your vault plus a running lookup service. Neither is
            wired to this Home yet, so this pane shows the shape without pretending to manage anything.
          </div>
        </div>
      </Stack>
    </Card>
  );
}
