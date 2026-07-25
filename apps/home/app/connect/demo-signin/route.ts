export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestPost, onRequestOptions } from '../../../server/connect/demo-accounts';
import { makeEnv } from '../../_lib/env';
export const POST = (request: Request) => onRequestPost({ request, env: makeEnv() });
export const OPTIONS = () => onRequestOptions();
