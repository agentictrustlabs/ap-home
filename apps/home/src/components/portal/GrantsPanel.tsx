'use client';
// Spec 400 W2 (B4) — ONE SCREEN OF EVERY GRANT an agent issued: apps (Home MCP connections among them), members,
// contacts, standing grants to runtimes, a coach's study grant — who holds it, what it permits, its digest, and the
// chain's word on whether it is revoked. The ACL a peer platform shows, made of our grants. Revoke here: the act is
// `access.grant.revoke` by digest — the Ask runs it, the person (or the org's steward) signs, the chain refuses the
// grant everywhere after.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { Section, List, Row, Empty, ErrorNote, Note, Button, Chip, Mono, Meta, SkeletonRows } from '../../ui';
import { AgentName } from '../shared/AgentName';
import { askCommand } from '../../home/ask-command';
import { auditGrantsThroughHarness, type GrantsAudit, type GrantRow } from '../../home/grants-harness';

const KIND_WORDS: Record<string, string> = { app: 'app', member: 'member', contact: 'contact', runtime: 'runtime', coach: 'coach' };

export function GrantsPanel({ subject }: { subject?: string }) {
  const { session, agentAddress } = useSession();
  const [audit, setAudit] = useState<GrantsAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session || !agentAddress) return;
    setBusy(true); setError(null);
    const r = await auditGrantsThroughHarness({ person: agentAddress as Address, session: { token: session.token }, ...(subject ? { subject } : {}) });
    setBusy(false);
    if (r.ok) setAudit(r.audit); else setError(r.error);
  }, [session, agentAddress, subject]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onDone = () => { void load(); };
    window.addEventListener('ap:ask-done', onDone);
    return () => window.removeEventListener('ap:ask-done', onDone);
  }, [load]);

  const revoke = (g: GrantRow) => {
    askCommand({ toolId: 'access.grant.revoke', args: { digest: g.digest, ...(audit?.subject ? { holder: audit.subject } : {}) }, message: `revoke the ${KIND_WORDS[g.kind] ?? g.kind} grant ${g.holderName ?? g.holder} holds (${g.digest.slice(0, 12)}…)` });
  };

  const live = audit?.grants.filter((g) => !g.revoked) ?? [];
  const gone = audit?.grants.filter((g) => g.revoked) ?? [];
  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}
      {/* STRUCTURE FIRST (owner, 2026-10-02): render the "Grants issued" section immediately with skeleton rows while
          the audit read is out, so the page looks complete rather than blank until it lands. */}
      <Section title="Grants issued" {...(audit ? { count: live.length, aside: <Meta>{audit.subjectName ?? audit.subject} · {audit.why === 'self' ? 'your own agent' : 'you steward this agent'}</Meta> } : {})}>
        {audit === null ? <SkeletonRows rows={3} /> : (
          live.length === 0 ? <Empty title="No live grants">{audit.note ?? 'This agent has issued no grant its records can enumerate.'}</Empty> : (
            <List>
              {live.map((g) => (
                <Row key={g.digest} title={<span><Chip>{KIND_WORDS[g.kind] ?? g.kind}</Chip> {/^0x[0-9a-f]{40}$/i.test(g.holder) ? <AgentName address={g.holder} /> : g.holderName ?? g.holder}</span>}
                  meta={<span>{g.what}{g.issuedAt ? ` · since ${new Date(g.issuedAt).toLocaleDateString()}` : ''}</span>}
                  side={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Mono title={g.digest}>{g.digest.slice(0, 14)}…</Mono><Button size="sm" variant="danger" onClick={() => revoke(g)} disabled={busy}>Revoke</Button></span>} />
              ))}
            </List>
          ))}
        </Section>
      {gone.length > 0 && (
        <Section title="Revoked" count={gone.length}>
          <List>
            {gone.map((g) => (
              <Row key={g.digest} title={<span><Chip tone="warn">{KIND_WORDS[g.kind] ?? g.kind}</Chip> {/^0x[0-9a-f]{40}$/i.test(g.holder) ? <AgentName address={g.holder} /> : g.holderName ?? g.holder}</span>} meta={<span>{g.what} · revoked on chain</span>} side={<Mono title={g.digest}>{g.digest.slice(0, 14)}…</Mono>} />
            ))}
          </List>
        </Section>
      )}
      <Note>A grant here is a delegation this agent signed. Revoking it is an on-chain act — it stops working at every gate that checks, not only at this Home.</Note>
    </>
  );
}
