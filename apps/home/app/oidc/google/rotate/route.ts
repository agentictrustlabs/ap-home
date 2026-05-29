export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestPost } from '../../../../server/oidc/google/rotate';
import { makeEnv } from '../../../_lib/env';

export const POST = (request: Request) => onRequestPost({ request, env: makeEnv() });
