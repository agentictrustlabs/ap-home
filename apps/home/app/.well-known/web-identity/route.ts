export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onWebIdentity } from '../../../server/fedcm';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onWebIdentity({ request, env: makeEnv() });
