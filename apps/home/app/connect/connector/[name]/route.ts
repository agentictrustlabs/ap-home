export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { onRequestPost, isConnectorName } from '../../../../server/connect/connector-calendar';
import { makeEnv } from '../../../_lib/env';
export const POST = (request: Request, ctx: { params: Promise<{ name: string }> }) => ctx.params.then(({ name }) => (isConnectorName(name) ? onRequestPost(name, { request, env: makeEnv() }) : Response.json({ ok: false, error: 'unknown connector' }, { status: 404 })));
