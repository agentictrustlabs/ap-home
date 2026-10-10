export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onAdminMe } from '../../../../server/connect/admin';
import { makeEnv } from '../../../_lib/env';

export const GET = (request: Request) => onAdminMe({ request, env: makeEnv() });
