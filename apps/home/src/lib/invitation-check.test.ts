// Recipient-side invitation verification — spec 338 §5 / §20, W6.
//
// The behaviour that matters most: a TAMPERED endpoint must fail, and a fully-passing invitation must
// still say "authorization not granted".

import { describe, expect, it } from 'vitest';
import {
  digestOf,
  publicationBody,
  type AgentConnectionInvitationV1,
  type AgentServicePublicationV1,
  type PrivateResolutionGrantV1,
} from '@agenticprimitives/agent-resolution';
import type { CanonicalAgentId } from '@agenticprimitives/types';
import {
  AUTHORIZATION_NOT_GRANTED,
  InvitationParseError,
  inspectInvitation,
} from './invitation-check';

const TARGET = 'eip155:84532:0xacc0000000000000000000000000000000000001' as CanonicalAgentId;
const BANK_A = 'eip155:84532:0xba00000000000000000000000000000000000001' as CanonicalAgentId;
const BANK_B = 'eip155:84532:0xba00000000000000000000000000000000000002' as CanonicalAgentId;
const CHANNEL = `${TARGET}:partner:${BANK_A}`;
const NOW = new Date('2026-07-31T12:00:00.000Z');
const now = () => NOW;

const grant = (over: Partial<PrivateResolutionGrantV1> = {}): PrivateResolutionGrantV1 => ({
  specVersion: 'ap.private-resolution-grant/1',
  grantId: 'apd1_7kpQxmVn0aZ8yLd3RtWcUvBn',
  issuer: TARGET,
  targetAgent: TARGET,
  subject: BANK_A,
  mode: 'subject-bound',
  actions: ['agent.resolve'],
  projection: { profile: 'partner' },
  constraints: {
    audience: 'https://resolve.acme.example/v1/private',
    notBefore: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    requireProofOfPossession: true,
  },
  statusRef: 'vault://acme/status',
  issuedAt: '2026-07-01T00:00:00.000Z',
  authorityRef: 'vault://acme/authority',
  proof: null,
  ...over,
});

async function publication(over: Partial<AgentServicePublicationV1> = {}): Promise<AgentServicePublicationV1> {
  const base = {
    specVersion: 'ap.agent-service-publication/1',
    publicationId: 'pub-0',
    channelId: CHANNEL,
    agentId: TARGET,
    sequence: 3n,
    status: 'active',
    surfaces: [
      {
        surfaceId: 'reconciliation',
        protocol: 'mcp',
        protocolVersion: '2025-06-18',
        uri: 'https://acme-internal.example/reconcile',
        exposure: 'private',
        audience: [BANK_A],
        securityRequirements: ['ap-delegation'],
      },
    ],
    issuedAt: '2026-07-31T11:00:00.000Z',
    expiresAt: '2026-07-31T18:00:00.000Z',
    publishedBy: TARGET,
    publicationAuthorityRef: 'vault://acme/pa/1',
    ...over,
  } as Omit<AgentServicePublicationV1, 'digest' | 'proofs'>;

  const digest = await digestOf(publicationBody(base));
  return { ...base, digest, proofs: [{ signer: TARGET, scheme: 'erc1271', signature: '0xdead' }] } as AgentServicePublicationV1;
}

async function invitation(over: Partial<AgentConnectionInvitationV1> = {}): Promise<AgentConnectionInvitationV1> {
  return {
    specVersion: 'ap.agent-connection-invitation/1',
    invitationId: 'inv-1',
    issuer: TARGET,
    targetAgent: TARGET,
    recipient: BANK_A,
    display: { label: 'Acme Treasury Settlement', purpose: 'reconciliation' },
    resolution: { method: 'private-grant', rendezvous: 'https://resolve.acme.example/v1/private', grant: grant() },
    initialPublication: await publication(),
    expectedBindings: { targetAgentId: TARGET, endpointProofRequired: false },
    issuedAt: '2026-07-31T11:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
    proof: null,
    ...over,
  };
}

/** bigint-safe stringify — the wire form the user actually pastes. */
const asJson = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));

const byId = (checks: { id: string; state: string }[], id: string) => checks.find((c) => c.id === id)!;

describe('a well-formed invitation', () => {
  it('passes every check it can, and marks the rest UNCHECKED rather than passed', async () => {
    const r = await inspectInvitation(asJson(await invitation()), now);

    expect(byId(r.checks, 'shape').state).toBe('pass');
    expect(byId(r.checks, 'expiry').state).toBe('pass');
    expect(byId(r.checks, 'digest').state).toBe('pass');
    expect(byId(r.checks, 'freshness').state).toBe('pass');
    expect(byId(r.checks, 'status').state).toBe('pass');

    // The honest gaps — never rendered as a pass.
    expect(byId(r.checks, 'signature').state).toBe('unchecked');
  });

  it('surfaces the private label the issuer chose for THIS recipient', async () => {
    const r = await inspectInvitation(asJson(await invitation()), now);
    expect(r.invitation.display?.label).toBe('Acme Treasury Settlement');
  });
});

describe('tampering is caught', () => {
  it('FAILS when the endpoint was changed after signing', async () => {
    const inv = await invitation();
    const tampered = {
      ...inv,
      initialPublication: {
        ...inv.initialPublication!,
        surfaces: [{ ...inv.initialPublication!.surfaces[0]!, uri: 'https://attacker.example/reconcile' }],
      },
    };

    const r = await inspectInvitation(asJson(tampered), now);

    expect(byId(r.checks, 'digest').state).toBe('fail');
    expect(r.failed).toBe(true);
  });

  it('FAILS when the grant targets a different agent than the invitation names', async () => {
    const inv = await invitation();
    const mismatched = {
      ...inv,
      resolution: { ...inv.resolution, grant: grant({ targetAgent: BANK_B }) },
    };

    const r = await inspectInvitation(asJson(mismatched), now);
    expect(byId(r.checks, 'shape').state).toBe('fail');
    expect(r.failed).toBe(true);
  });

  it('FAILS when the grant subject is not the invitation recipient', async () => {
    const inv = await invitation();
    const r = await inspectInvitation(
      asJson({ ...inv, resolution: { ...inv.resolution, grant: grant({ subject: BANK_B }) } }),
      now,
    );

    expect(byId(r.checks, 'shape').state).toBe('fail');
  });
});

describe('staleness and lifecycle', () => {
  it('FAILS an expired invitation', async () => {
    const r = await inspectInvitation(asJson(await invitation({ expiresAt: '2026-07-01T00:00:00.000Z' })), now);
    expect(byId(r.checks, 'expiry').state).toBe('fail');
  });

  it('FAILS when the service details have expired', async () => {
    const stale = await publication({ expiresAt: '2026-07-31T11:30:00.000Z' });
    const r = await inspectInvitation(asJson(await invitation({ initialPublication: stale })), now);

    expect(byId(r.checks, 'freshness').state).toBe('fail');
  });

  it('FAILS a non-active publication', async () => {
    for (const status of ['revoked', 'suspended', 'compromised'] as const) {
      const p = await publication({ status });
      const r = await inspectInvitation(asJson(await invitation({ initialPublication: p })), now);
      expect(byId(r.checks, 'status').state, status).toBe('fail');
    }
  });

  it('FAILS when no service details are attached at all', async () => {
    const inv = await invitation();
    const { initialPublication: _drop, ...without } = inv;
    const r = await inspectInvitation(asJson(without), now);

    expect(byId(r.checks, 'publication').state).toBe('fail');
    expect(r.failed).toBe(true);
  });
});

describe('endpoint control', () => {
  it('FAILS when no endpoint-control proof is attached — claim is not control', async () => {
    const r = await inspectInvitation(asJson(await invitation()), now);
    expect(byId(r.checks, 'endpoint-control').state).toBe('fail');
  });

  it('marks an attached proof UNCHECKED — it is verified by the connecting agent, not here', async () => {
    const p = await publication({
      surfaces: [
        {
          surfaceId: 'reconciliation',
          protocol: 'mcp',
          protocolVersion: '2025-06-18',
          uri: 'https://acme-internal.example/reconcile',
          exposure: 'private',
          audience: [BANK_A],
          securityRequirements: ['ap-delegation'],
          endpointControlProof: {
            method: 'signed-challenge',
            evidenceRef: 'vault://acme/ec/1',
            verifiedAt: '2026-07-31T11:00:00.000Z',
          },
        },
      ],
    });

    const r = await inspectInvitation(asJson(await invitation({ initialPublication: p })), now);
    expect(byId(r.checks, 'endpoint-control').state).toBe('unchecked');
  });
});

describe('input handling', () => {
  it('rejects non-JSON with a readable message', async () => {
    await expect(inspectInvitation('not json', now)).rejects.toBeInstanceOf(InvitationParseError);
  });

  it('rejects a document that is not an invitation', async () => {
    await expect(inspectInvitation('{"specVersion":"something/else"}', now)).rejects.toBeInstanceOf(
      InvitationParseError,
    );
  });
});

describe('the sentence that must survive a redesign', () => {
  it('says permission is NOT granted, and never implies access', async () => {
    expect(AUTHORIZATION_NOT_GRANTED).toMatch(/refused/i);
    expect(AUTHORIZATION_NOT_GRANTED).toMatch(/separate, revocable permission/i);
    // A fully-passing invitation still grants nothing.
    const r = await inspectInvitation(asJson(await invitation()), now);
    expect(byId(r.checks, 'shape').state).toBe('pass');
    expect(AUTHORIZATION_NOT_GRANTED).not.toMatch(/you (now )?have access/i);
  });
});
