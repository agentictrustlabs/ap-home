export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onFedcmGrant, onFedcmGrantOptions } from '../../../server/fedcm';
import { makeEnv } from '../../_lib/env';

export const POST = (request: Request) => onFedcmGrant({ request, env: makeEnv() });
export const OPTIONS = (request: Request) => onFedcmGrantOptions({ request, env: makeEnv() });
