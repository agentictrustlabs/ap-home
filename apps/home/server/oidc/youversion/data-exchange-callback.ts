// YouVersion Data Exchange callback (spec 265 W5). After the user approves (or cancels) "highlights" on
// YouVersion's approval page, YouVersion redirects the browser here (the app's Portal-configured
// data-exchange callback URL) with `data_exchange_status=granted|cancelled`. No token crosses this hop —
// the highlights grant lives server-side at YouVersion, tied to the user + app; afterwards the person's
// custodied access_token is authorized for GET /v1/highlights. We just land the user back on Connected Apps
// with the outcome so the UI can re-enable "Show my highlights".
import type { FnContext } from '../../_lib/server-broker';

export const onRequestGet = async ({ request }: FnContext): Promise<Response> => {
  const u = new URL(request.url);
  const status = u.searchParams.get('data_exchange_status') ?? 'unknown';
  const outcome = status === 'granted' ? 'granted' : status === 'cancelled' ? 'cancelled' : 'error';
  const dest = new URL('/apps', u.origin);
  dest.searchParams.set('yv_highlights', outcome);
  return Response.redirect(dest.toString(), 302);
};
