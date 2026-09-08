// THE REALTIMEKIT ADAPTER — spec 378 §3. `MediaProviderPort` over Cloudflare's management API.
//
// Cloudflare carries the call; this file is the only place the provider is named. Secrets come from the
// Worker env; a deployment that has a huddle surface but no provider credentials is a THROWN configuration
// error at the first call, never a fallback (ADR-0013). Nothing here logs a participant token: it is
// returned once to the participating browser and forgotten.
//
//   POST   accounts/{account}/realtime/kit/{app}/meetings                         → { data: { id } }
//   POST   …/meetings/{id}/participants  { name, preset_name, custom_participant_id } → { data: { id, token } }
//   DELETE …/meetings/{id}/participants/{participantId}
//   POST   …/meetings/{id}/active-session/kick-all
//   PATCH  …/meetings/{id}  { status: "INACTIVE" }
//   webhooks: header `rtk-signature`, RSA-SHA256 over the raw body, public key at
//             https://api.realtime.cloudflare.com/.well-known/webhooks.json
import type { MediaProviderPort, ProviderWebhookEvent } from '@agenticprimitives/collaboration';

export interface RealtimeKitEnv {
  REALTIMEKIT_ACCOUNT_ID?: string;
  REALTIMEKIT_APP_ID?: string;
  REALTIMEKIT_API_TOKEN?: string;
  /** Preset names as created in the RealtimeKit app (defaults: the app's group-call presets). */
  REALTIMEKIT_PRESET_HOST?: string;
  REALTIMEKIT_PRESET_PARTICIPANT?: string;
  REALTIMEKIT_API_BASE?: string;
}

export const REALTIMEKIT_WEBHOOK_KEYS_URL = 'https://api.realtime.cloudflare.com/.well-known/webhooks.json';

export function realtimeKitConfigured(env: RealtimeKitEnv): boolean {
  return !!(env.REALTIMEKIT_ACCOUNT_ID?.trim() && env.REALTIMEKIT_APP_ID?.trim() && env.REALTIMEKIT_API_TOKEN?.trim());
}

type ApiEnvelope<T> = { success?: boolean; data?: T; errors?: Array<{ message?: string }>; error?: string | { code?: number; message?: string }; message?: string };

export function createRealtimeKitProvider(env: RealtimeKitEnv, fetchImpl: typeof fetch = fetch): MediaProviderPort {
  if (!realtimeKitConfigured(env)) throw new Error('huddles_not_configured: REALTIMEKIT_ACCOUNT_ID, REALTIMEKIT_APP_ID and REALTIMEKIT_API_TOKEN are required (wrangler secret put …)');
  const base = `${(env.REALTIMEKIT_API_BASE ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '')}/accounts/${env.REALTIMEKIT_ACCOUNT_ID!.trim()}/realtime/kit/${env.REALTIMEKIT_APP_ID!.trim()}`;
  const headers = { authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN!.trim()}`, 'content-type': 'application/json', accept: 'application/json' };
  const presetHost = env.REALTIMEKIT_PRESET_HOST?.trim() || 'group_call_host';
  const presetParticipant = env.REALTIMEKIT_PRESET_PARTICIPANT?.trim() || 'group_call_participant';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let parsed: ApiEnvelope<T> | null = null;
    try { parsed = text ? (JSON.parse(text) as ApiEnvelope<T>) : null; } catch { parsed = null; }
    if (!res.ok || parsed?.success === false) {
      const errObj = parsed?.error && typeof parsed.error === 'object' ? parsed.error.message : parsed?.error;
      const why = parsed?.errors?.map((e) => e.message).filter(Boolean).join('; ') || errObj || parsed?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      const err = new Error(`realtimekit ${method} ${path}: ${res.status} ${why}`) as Error & { status?: number; why?: string };
      err.status = res.status; err.why = String(why);
      throw err;
    }
    return (parsed?.data ?? (parsed as unknown)) as T;
  };
  return {
    async createMeeting({ title }) {
      const data = await call<{ id?: string; meeting_id?: string }>('POST', '/meetings', { title, record_on_start: false });
      const meetingId = data.id ?? data.meeting_id;
      if (!meetingId) throw new Error('realtimekit createMeeting: no meeting id in the response');
      return { meetingId };
    },
    async addParticipant({ meetingId, displayName, role, correlationId }) {
      const data = await call<{ id?: string; participant_id?: string; token?: string; authToken?: string; auth_token?: string }>('POST', `/meetings/${encodeURIComponent(meetingId)}/participants`, {
        name: displayName.slice(0, 80), preset_name: role === 'host' ? presetHost : presetParticipant, custom_participant_id: correlationId,
      });
      const participantId = data.id ?? data.participant_id;
      const authToken = data.token ?? data.authToken ?? data.auth_token;
      if (!participantId || !authToken) throw new Error('realtimekit addParticipant: no participant id or token in the response');
      return { participantId, authToken };
    },
    async removeParticipant({ meetingId, participantId }) {
      await call('DELETE', `/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}`);
    },
    async endSession({ meetingId }) {
      // "No active session" is not a failure to end: there was nothing live to drop. Every other refusal is.
      try { await call('POST', `/meetings/${encodeURIComponent(meetingId)}/active-session/kick-all`); }
      catch (e) { const x = e as Error & { status?: number; why?: string }; if (x.status === 404 && /no active session/i.test(x.why ?? '')) return; throw e; }
    },
    async deactivateMeeting({ meetingId }) {
      await call('PATCH', `/meetings/${encodeURIComponent(meetingId)}`, { status: 'INACTIVE' });
    },
  };
}

// ── Webhooks ──────────────────────────────────────────────────────────────────────────────────────────

let cachedKey: { pem: string; at: number } | null = null;

async function webhookPublicKeyPem(fetchImpl: typeof fetch): Promise<string> {
  if (cachedKey && Date.now() - cachedKey.at < 3600_000) return cachedKey.pem;
  const res = await fetchImpl(REALTIMEKIT_WEBHOOK_KEYS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`realtimekit webhook keys: HTTP ${res.status}`);
  const j = (await res.json()) as { publicKey?: string; public_key?: string; keys?: Array<{ publicKey?: string; public_key?: string; pem?: string }> };
  const pem = j.publicKey ?? j.public_key ?? j.keys?.[0]?.publicKey ?? j.keys?.[0]?.public_key ?? j.keys?.[0]?.pem;
  if (!pem) throw new Error('realtimekit webhook keys: no public key in the document');
  cachedKey = { pem, at: Date.now() };
  return pem;
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Verify `rtk-signature` (base64 RSA-SHA256 over the raw body) against the published key. Pure apart from the key fetch. */
export async function verifyRealtimeKitWebhook(rawBody: string, signatureB64: string | null, fetchImpl: typeof fetch = fetch, pemOverride?: string): Promise<boolean> {
  if (!signatureB64) return false;
  try {
    const pem = pemOverride ?? (await webhookPublicKeyPem(fetchImpl));
    const key = await crypto.subtle.importKey('spki', pemToDer(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(rawBody));
  } catch {
    return false;
  }
}

/** The provider's payload, read into the port's event: the meeting id, the participant, and the correlation id. */
export function readRealtimeKitWebhook(payload: Record<string, unknown>): ProviderWebhookEvent | null {
  const event = String(payload.event ?? '');
  if (!event) return null;
  const meeting = (payload.meeting ?? {}) as Record<string, unknown>;
  const participant = (payload.participant ?? {}) as Record<string, unknown>;
  const meetingId = String(meeting.id ?? payload.meetingId ?? payload.meeting_id ?? '');
  if (!meetingId) return null;
  const participantId = participant.id ? String(participant.id) : participant.participantId ? String(participant.participantId) : undefined;
  const correlationId = participant.customParticipantId ? String(participant.customParticipantId) : participant.custom_participant_id ? String(participant.custom_participant_id) : undefined;
  const atRaw = (payload.timestamp ?? meeting.endedAt ?? meeting.startedAt ?? participant.leftAt ?? participant.joinedAt) as string | number | undefined;
  const at = typeof atRaw === 'number' ? atRaw : atRaw ? Date.parse(String(atRaw)) || Date.now() : Date.now();
  return { event, meetingId, ...(participantId ? { participantId } : {}), ...(correlationId ? { correlationId } : {}), at };
}
