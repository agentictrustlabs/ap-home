export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestGet } from '../../../server/connect/name-info';
import { makeEnv } from '../../_lib/env';

export const GET = (request: Request) => onRequestGet({ request, env: makeEnv() });
