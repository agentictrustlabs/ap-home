// The email a person verified (6-digit code) IN THIS WINDOW, remembered for the rest of the same window.
//
// A relying app's consent screen names the person by their email ("Signed in as host@church.org"). Reading
// it back off their vault profile takes a round trip that can lose a 5 s race, which left the line saying
// `0x8bca…3807` instead. But the person typed and verified that email a few seconds earlier, in this very
// window — so the code step leaves it here and the consent screen reads it first.
//
// sessionStorage: per tab, same origin, gone when the window closes. Keyed by the home's address so a
// later sign-in as somebody else in the same tab never shows the previous person's email. Display only:
// it is never sent anywhere and authorizes nothing.
const KEY = 'verifiedEmail';
// Paul, 2026-10-15: the Allow screen said only "Signed in" when it opened in ANOTHER tab or window than the code
// step (sessionStorage is per tab), and a new account's vault profile has no email yet to fall back on. So the
// email is also kept on this device, per account, in localStorage — still display only, still keyed by address.
const DEVICE_KEY = 'verifiedEmailByAddress';

export function rememberVerifiedEmail(address: string | null | undefined, email: string): void {
  if (!address || !email.includes('@')) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ address: address.toLowerCase(), email: email.trim().toLowerCase() }));
  } catch {
    /* storage unavailable — the profile read still runs */
  }
  try {
    const all = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '{}') as Record<string, string>;
    all[address.toLowerCase()] = email.trim().toLowerCase();
    localStorage.setItem(DEVICE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function verifiedEmailFor(address: string | null | undefined): string {
  if (!address) return '';
  try {
    const raw = sessionStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as { address?: unknown; email?: unknown }) : null;
    if (v && typeof v.address === 'string' && typeof v.email === 'string' && v.address === address.toLowerCase()) return v.email;
  } catch {
    /* fall through to the device copy */
  }
  try {
    const all = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '{}') as Record<string, unknown>;
    const e = all[address.toLowerCase()];
    return typeof e === 'string' && e.includes('@') ? e : '';
  } catch {
    return '';
  }
}
