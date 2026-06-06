export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onAssertion, onAssertionOptions } from '../../../server/fedcm';
import { makeEnv } from '../../_lib/env';

export const POST = (request: Request) => onAssertion({ request, env: makeEnv() });
export const OPTIONS = (request: Request) => onAssertionOptions({ request, env: makeEnv() });
