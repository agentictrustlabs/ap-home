// A Home's sign-out passes through here (spec 445 §16). The session lives in one tab's sessionStorage, so this tab cannot clear another:
// the marker in localStorage tells every other tab, and app.js refuses any session older than it.
const home = document.currentScript.dataset.home;
try { localStorage.setItem('estate.signed-out', String(Date.now())); } catch { /* blocked: this tab is still cleared below */ }
try { sessionStorage.removeItem('estate.home-session'); } catch { /* blocked */ }
// Back to the Home's sign-out, and nowhere else: a return to any other place would be an open redirect.
let back = '/';
try {
  const u = new URL(new URLSearchParams(location.search).get('return') ?? '');
  if (u.origin === home && u.pathname === '/logout') back = u.toString();
} catch { /* no return, or a malformed one: stay on this site */ }
location.replace(back);
