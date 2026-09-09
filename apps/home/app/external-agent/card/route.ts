export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { clockCard } from './card';
export const GET = () => new Response(JSON.stringify(clockCard()), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
