export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onConfig } from '../../../server/fedcm';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onConfig({ request, env: makeEnv() });
