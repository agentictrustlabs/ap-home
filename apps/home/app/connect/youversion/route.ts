export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestGet, onRequestPost } from '../../../server/connect/youversion';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onRequestGet({ request, env: makeEnv() });
export const POST = (request: Request) => onRequestPost({ request, env: makeEnv() });
