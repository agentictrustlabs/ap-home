export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onAdminAzureCosts } from '../../../../server/connect/admin';
import { makeEnv } from '../../../_lib/env';

export const GET = (request: Request) => onAdminAzureCosts({ request, env: makeEnv() });
