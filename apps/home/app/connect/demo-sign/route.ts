export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestPut, onRequestOptions } from '../../../server/connect/demo-accounts';
import { makeEnv } from '../../_lib/env';
// PUT (not POST) so this stays a distinct verb from the session-gated /connect/persona-sign, and a
// stray POST to the wrong path can never reach the secret-gated signer.
export const PUT = (request: Request) => onRequestPut({ request, env: makeEnv() });
export const OPTIONS = () => onRequestOptions();
