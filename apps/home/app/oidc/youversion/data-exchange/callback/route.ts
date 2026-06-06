export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestGet } from '../../../../../server/oidc/youversion/data-exchange-callback';
import { makeEnv } from '../../../../_lib/env';

export const GET = (request: Request) => onRequestGet({ request, env: makeEnv() });
