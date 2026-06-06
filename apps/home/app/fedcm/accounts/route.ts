export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onAccounts } from '../../../server/fedcm';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onAccounts({ request, env: makeEnv() });
