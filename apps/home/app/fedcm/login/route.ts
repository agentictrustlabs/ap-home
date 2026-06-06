export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onLogin } from '../../../server/fedcm';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onLogin({ request, env: makeEnv() });
