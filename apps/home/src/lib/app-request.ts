// AN APP'S ONE REQUEST — a window an app opened for one friend act (`/friends?add|remove=…&from=<app>&name=…`). The
// Home shows only that act; if the person must sign in first, the sign-in says what it is for and brings them back
// here afterwards (Google returns to `/`, so the request is remembered across that trip).
export interface AppRequest {
  /** A friend act, a profile change the app proposed (`/profile-update?p=…&from=<app>`), or the inviter's half of an
   *  email invitation the app just sent (`/friend-invitation?t=…&from=<app>`). */
  act: 'add' | 'remove' | 'profile' | 'invitation';
  /** How the app named the friend, when it did. */
  name: string | null;
  from: string;
}

const RETURN_KEY = 'ap-app-request-return';

export function appRequestOf(loc: Pick<Location, 'pathname' | 'search'> = window.location): AppRequest | null {
  const q = new URLSearchParams(loc.search);
  const from = q.get('from');
  if (loc.pathname === '/profile-update') return from && q.get('p') ? { act: 'profile', name: null, from } : null;
  if (loc.pathname === '/friend-invitation') return from && q.get('t') ? { act: 'invitation', name: null, from } : null;
  const act = q.get('add') ? 'add' : q.get('remove') ? 'remove' : null;
  if ((loc.pathname !== '/friends' && loc.pathname !== '/contacts') || !from || !act) return null;
  return { act, name: q.get('name')?.trim() || null, from };
}

/** Before leaving for a sign-in that comes back to `/`: remember where the request was. */
export function rememberAppRequest(): void {
  try {
    if (appRequestOf()) sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
  } catch { /* storage blocked: the person reopens it from the app */ }
}

/** Once signed in: the request to go back to, once. */
export function takeAppRequestReturn(): string | null {
  try {
    const to = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return to && (to.startsWith('/friends?') || to.startsWith('/contacts?') || to.startsWith('/profile-update?') || to.startsWith('/friend-invitation?')) ? to : null;
  } catch {
    return null;
  }
}
