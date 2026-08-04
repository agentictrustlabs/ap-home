export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestGet, onRequestPost, onRequestDelete, onRequestOptions } from '../../../server/connect/messaging-wire';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onRequestGet({ request, env: makeEnv() });
export const POST = (request: Request) => onRequestPost({ request, env: makeEnv() });
export const DELETE = (request: Request) => onRequestDelete({ request, env: makeEnv() });
export const OPTIONS = (request: Request) => onRequestOptions({ request, env: makeEnv() });
