export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestPost, onRequestOptions } from '../../../../server/connect/inbox-deliver';
import { makeEnv } from '../../../_lib/env';

export const POST = (request: Request) => onRequestPost({ request, env: makeEnv() });
export const OPTIONS = () => onRequestOptions();
