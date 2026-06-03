export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestGet, onRequestOptions } from '../../../server/connect/nonce';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onRequestGet({ request, env: makeEnv() });
export const OPTIONS = (request: Request) => onRequestOptions({ request, env: makeEnv() });
