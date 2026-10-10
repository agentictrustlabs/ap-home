export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onAdminAccounts } from '../../../../server/connect/admin';
import { makeEnv } from '../../../_lib/env';

export const GET = (request: Request) => onAdminAccounts({ request, env: makeEnv() });
