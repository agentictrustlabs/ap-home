export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestPost, onRequestGet, onRequestOptions } from '../../../server/connect/profile-proposal';
import { makeEnv } from '../../_lib/env';
export const POST = (request: Request) => onRequestPost({ request, env: makeEnv() });
export const GET = (request: Request) => onRequestGet({ request, env: makeEnv() });
export const OPTIONS = (request: Request) => onRequestOptions({ request, env: makeEnv() });
