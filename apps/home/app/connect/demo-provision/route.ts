export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestPut, onRequestOptions } from '../../../server/connect/demo-provision';
import { makeEnv } from '../../_lib/env';
export const PUT = (request: Request) => onRequestPut({ request, env: makeEnv() });
export const OPTIONS = () => onRequestOptions();
