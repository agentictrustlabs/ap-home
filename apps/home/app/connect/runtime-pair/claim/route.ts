export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestPost } from '../../../../server/connect/runtime-pair';
import { makeEnv } from '../../../_lib/env';
export const POST = (request: Request) => onRequestPost('claim', { request, env: makeEnv() });
