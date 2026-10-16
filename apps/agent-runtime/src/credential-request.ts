// A MEMBER ASKS HER ORGANIZATION FOR A CREDENTIAL — spec 444 W4, capability `credential.request`.
//
// HER act, at HER agent: it grants nothing and needs no mandate. Issuing is the organization's act under its steward's
// mandate (`credential.issue`); a member holds no authority to make the organization vouch, so what she can do is ASK, the
// way mail is admitted. Her agent:
//   1. STANDING   asks the organization's own object whether it records her as a member — a request from someone it does
//                 not record would be a request to be admitted, which is an application, not this;
//   2. HER KEY    reads the PUBLIC half of her device key from her own vault (`credential.device-key:<thumbprint>`,
//                 `publicJwk`); the private scalar is never read here;
//   3. ASK        deposits `credential.request:<her address>` in the ORGANIZATION's vault, written by the organization's
//                 own grant in its own object (the payee's-receipt pattern): one per member, a new ask replaces her last.
// The steward's `credential.issue` then binds the credential to the key her request names, and marks it issued.
import { type ToolSpec, type ToolInvoker } from '@agenticprimitives/orchestration';
import { ADAPTER } from './adapter-declarations.js';
import type { OrgMembershipAnswer } from './member-roles.js';

export const CREDENTIAL_REQUEST_CAPABILITY = 'credential.request' as const;
export const REQUEST_PREFIX = 'credential.request:' as const;
const DEVICE_KEY_PREFIX = 'credential.device-key:';
const ADDR = /^0x[0-9a-f]{40}$/;

export interface CredentialRequestV1 {
  type: 'ap.credential-request.v1';
  member: string;
  credentialType: string;
  deviceKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  deviceKeyThumbprint: string;
  requestedAt: string;
  status: 'open' | 'issued';
  issued?: { digest: string; at: string; by: string };
}

export const CREDENTIAL_REQUEST_TOOL: ToolSpec = {
  id: CREDENTIAL_REQUEST_CAPABILITY,
  verbs: ['ask for a credential', 'request a credential', 'request my membership credential'],
  description:
    'Asks an organization the person BELONGS TO for an anonymous credential it vouches for (a membership credential), bound '
    + 'to the person\'s own device key, so its steward can issue it. The person\'s own act; it grants nothing and issues '
    + 'nothing — the steward issues. Only to an organization whose records name them a member. Args: org (the organization, '
    + 'as the ask names it), credentialType (default "membership").',
  inputSchema: { type: 'object', properties: { org: { type: 'string', description: 'The organization they belong to' }, credentialType: { type: 'string' } }, required: ['org'] },
  capability: { id: CREDENTIAL_REQUEST_CAPABILITY, action: 'request', resourceArg: 'org' },
  risk: 'low', adapter: ADAPTER.sync,
  selfAuthorized: true,
  establishes: 'authoritative',
};

export interface CredentialRequestDeps {
  memberRoleAt: (org: string, member: string) => Promise<OrgMembershipAnswer | null>;
  survey: (subject: string) => Promise<Array<{ recordType: string }>>;
  readRecord: (subject: string, recordType: string) => Promise<unknown>;
  writeRecord: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  nameOf?: (address: string) => Promise<string | null>;
}

const isPublicJwk = (k: unknown): k is { kty: 'EC'; crv: 'P-256'; x: string; y: string } => {
  const o = k as Record<string, unknown> | null;
  return !!o && o.kty === 'EC' && o.crv === 'P-256' && typeof o.x === 'string' && typeof o.y === 'string';
};

export function credentialRequestInvoker(deps: CredentialRequestDeps, person: string | undefined): ToolInvoker {
  return async (_toolId, args) => {
    if (!person) return { refused: 'asking for a credential is the member\'s own act, and there is no signed-in person on this run' };
    const me = person.toLowerCase();
    const org = String(args.org ?? '').toLowerCase();
    if (!ADDR.test(org)) return { refused: 'which organization? name the one you belong to' };
    const name = (deps.nameOf ? await deps.nameOf(org).catch(() => null) : null) ?? org;
    // 1. STANDING — the organization's own record, asked of its own object.
    const standing = await deps.memberRoleAt(org, me).catch(() => null);
    if (!standing) return { refused: `${name} could not be asked whether you belong to it just now — nothing was sent`, code: 'org_unreadable' };
    if (!standing.membership || standing.ended) return { refused: `${name} does not record you as a member — ask to join it first; a credential is only for its members`, code: 'not_a_member' };
    // 2. HER KEY — the public half, from her own vault.
    const keys = (await deps.survey(me)).map((r) => r.recordType).filter((t) => t.startsWith(DEVICE_KEY_PREFIX)).sort();
    let device: { jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; thumbprint: string } | null = null;
    for (const t of keys) {
      const rec = (await deps.readRecord(me, t).catch(() => null)) as { thumbprint?: string; publicJwk?: unknown } | null;
      if (rec && isPublicJwk(rec.publicJwk)) { device = { jwk: { kty: 'EC', crv: 'P-256', x: rec.publicJwk.x, y: rec.publicJwk.y }, thumbprint: String(rec.thumbprint ?? t.slice(DEVICE_KEY_PREFIX.length)) }; break; }
    }
    if (!device) return { refused: 'your vault holds no device key whose public half is recorded — a credential is bound to one, so set up a device key first', code: 'no_device_key' };
    // 3. ASK — her request, in the organization's vault, by the organization's own grant.
    const request: CredentialRequestV1 = {
      type: 'ap.credential-request.v1', member: me, credentialType: String(args.credentialType ?? 'membership'),
      deviceKey: device.jwk, deviceKeyThumbprint: device.thumbprint, requestedAt: new Date().toISOString(), status: 'open',
    };
    const w = await deps.writeRecord(org, `${REQUEST_PREFIX}${me}`, request);
    if (!w.ok) return { refused: `${name} did not take your request (${w.error ?? 'refused'}) — nothing was sent`, code: 'request_refused' };
    return {
      requested: true, org, credentialType: request.credentialType, deviceKeyThumbprint: device.thumbprint,
      answer: `Asked ${name} for a ${request.credentialType} credential bound to your device key ${device.thumbprint.slice(0, 10)}…. Its steward issues it; it will arrive in your own vault.`,
    };
  };
}
