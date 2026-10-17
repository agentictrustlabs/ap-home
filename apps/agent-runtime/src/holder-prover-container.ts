// THE HOLDER'S PROVER CONTAINER (private-scripture W4) — the Node prover beside this Worker, never inside it: the OpenAC 1k
// Prepare proving key is 274 MB. One instance, named `holder-prover`; it sleeps after an idle hour and the first presentation
// after that pays a cold start and its own Prepare (its spare pool lives in memory). The Worker reaches it only as
// `POST /present` and `POST /warm`, under the secret it hands the Container at start. What the Container is given: the
// holder caller's key-service token (her device keys sign ES256_SHA256 only under bound evidence), the evidence key that
// mints that evidence after the release has judged the mandate, and the chain endpoint the release judges it on.
import { Container } from '@cloudflare/containers';
import type { Env } from './index.js';

export class HolderProverContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = '1h';
  override enableInternet = true;
  override async fetch(req: Request): Promise<Response> {
    const e = this.env as unknown as Record<string, string | undefined>;
    const missing = ['PROVER_SECRET', 'AKCS_HOLDER_TOKEN', 'ISSUANCE_EVIDENCE_ES256_KEY', 'ISSUANCE_EVIDENCE_ISSUER', 'ISSUANCE_EVIDENCE_AUDIENCE', 'RPC_URL', 'UNIVERSAL_SIGNATURE_VALIDATOR'].filter((k) => !e[k]?.trim());
    if (missing.length) return new Response(JSON.stringify({ error: `the prover is not configured: missing ${missing.join(', ')}` }), { status: 503, headers: { 'content-type': 'application/json' } });
    this.envVars = {
      PROVER_SECRET: e.PROVER_SECRET!,
      AKCS_HOLDER_TOKEN: e.AKCS_HOLDER_TOKEN!,
      // The same evidence key the issuer uses: the key service's [authority_evidence] trusts one issuer per node.
      PRESENTATION_EVIDENCE_ES256_KEY: e.ISSUANCE_EVIDENCE_ES256_KEY!,
      PRESENTATION_EVIDENCE_ISSUER: e.ISSUANCE_EVIDENCE_ISSUER!,
      PRESENTATION_EVIDENCE_AUDIENCE: e.ISSUANCE_EVIDENCE_AUDIENCE!,
      RPC_URL: e.RPC_URL!,
      UNIVERSAL_SIGNATURE_VALIDATOR: e.UNIVERSAL_SIGNATURE_VALIDATOR!,
    };
    return super.fetch(req);
  }
}
