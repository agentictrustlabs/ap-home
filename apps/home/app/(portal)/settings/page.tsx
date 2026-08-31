// Settings is a PANE, not a page (spec 348 §2.3) — landing on it means "open the pane", so it goes
// straight to its first item rather than showing an index of what is already on screen beside it.
import { redirect } from 'next/navigation';
export default function SettingsIndex() { redirect('/profile'); }
