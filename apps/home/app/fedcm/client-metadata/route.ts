export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onClientMetadata } from '../../../server/fedcm';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onClientMetadata({ request, env: makeEnv() });
