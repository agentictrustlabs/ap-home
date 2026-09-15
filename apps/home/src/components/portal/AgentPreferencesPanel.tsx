'use client';
// YOUR AGENT'S PREFERENCES — spec 403 W2/W4. How your agent reaches you when you are away (a reminder at its hour, an
// act parked for your signature — by email, to the address on your profile; routine answers only if you say so) and
// how it answers (brief or full, in which language, calling you what). One record in your vault; any Home renders it.
// Nothing here is authority: a nudge is a message about a run, never the run.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { personPreferences, type PersonPreferencesView, type PreferencesChange } from '../../home/ask';
import { activateInteractionsIfNeeded, resolveVia } from '../../home/onboarding';
import { Card, KeyValue, Switch, Meta, Micro, ErrorNote, Button } from '../../ui';
import { BusyButton } from '../shared/BusyButton';

export function AgentPreferencesPanel() {
  const { session, agentAddress, profile } = useSession();
  const [email, setEmail] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PersonPreferencesView | null>(null);
  const [emailRail, setEmailRail] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ language: string; callMe: string }>({ language: '', callMe: '' });
  const scopeBehind = !!err && /record_scope_denied|scope/i.test(err);

  const load = useCallback(async () => {
    if (!session) return;
    const r = await personPreferences(session);
    if (!r.ok) { setErr(r.error); return; }
    setErr(null); setPrefs(r.preferences); setEmailRail(r.emailRail); setEmail(r.email);
    setDraft({ language: r.preferences.answer?.language ?? '', callMe: r.preferences.answer?.callMe ?? '' });
  }, [session?.token]);
  useEffect(() => { void load(); }, [load]);

  const change = async (key: string, set: PreferencesChange) => {
    if (!session) return;
    setBusy(key); setErr(null);
    const r = await personPreferences(session, set);
    setBusy(null);
    if (!r.ok) { setErr(r.error); return; }
    setPrefs(r.preferences);
  };
  const refreshGrant = async () => {
    if (!session || !agentAddress) return;
    setBusy('grant'); setErr(null);
    try {
      const r = await activateInteractionsIfNeeded(agentAddress as `0x${string}`, resolveVia(profile?.credential, session.via), { token: session.token }, true);
      if (!r.ok) setErr(r.error ?? 'the grant could not be refreshed'); else await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  if (!session) return null;
  const notifyEmail = prefs?.notify?.email !== false;
  const routines = prefs?.notify?.routines === true;
  const style = prefs?.answer?.style ?? null;
  return (
    <Card title="Your agent" testId="agent-preferences">
      <Meta>How your agent reaches you when you are away, and how it answers. Kept in your own vault.</Meta>
      {err && !scopeBehind && <ErrorNote>{err}</ErrorNote>}
      {scopeBehind && <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}><Micro>Your agent&rsquo;s grant predates preferences. Refresh it once — your signature, nothing else changes.</Micro><BusyButton busy={busy === 'grant'} busyLabel="Refreshing…" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => void refreshGrant()}>Refresh the grant</BusyButton></div>}
      {prefs && (
        <KeyValue rows={[
          ['Email me', <span key="e" style={{ display: 'inline-flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Switch checked={notifyEmail} busy={busy === 'email'} label="Email me reminders and acts waiting for my signature" onChange={() => void change('email', { notify: { email: !notifyEmail } })} data-testid="pref-email" />
            <Micro>{email ? `reminders and acts waiting for your signature → ${email}` : 'no email on your profile yet — add one under Profile'}{emailRail ? '' : ' · this deployment has no email rail'}</Micro>
          </span>],
          ['Routine answers', <span key="r" style={{ display: 'inline-flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Switch checked={routines} busy={busy === 'routines'} label="Email me my routines' answers too" onChange={() => void change('routines', { notify: { routines: !routines } })} data-testid="pref-routines" />
            <Micro>they always land in your Messages; by email only if you want them there</Micro>
          </span>],
          ['Answer style', <span key="s" style={{ display: 'inline-flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            {(['brief', 'full'] as const).map((v) => <Button key={v} size="sm" variant={style === v ? 'primary' : 'secondary'} disabled={busy === 'style'} onClick={() => void change('style', { answer: { style: style === v ? null : v } })} data-testid={`pref-style-${v}`}>{v === 'brief' ? 'Brief' : 'Full'}</Button>)}
            <Micro>{style ? (style === 'brief' ? 'a sentence or two' : 'the whole answer with its evidence') : 'the length the question needs'}</Micro>
          </span>],
          ['Language', <span key="l" style={{ display: 'inline-flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="ui-input" placeholder="e.g. Spanish" value={draft.language} onChange={(e) => setDraft((d) => ({ ...d, language: e.target.value }))} style={{ width: 160 }} data-testid="pref-language" />
            <BusyButton busy={busy === 'language'} busyLabel="Keeping…" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => void change('language', { answer: { language: draft.language.trim() || null } })}>Keep</BusyButton>
          </span>],
          ['Call me', <span key="c" style={{ display: 'inline-flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="ui-input" placeholder="a name" value={draft.callMe} onChange={(e) => setDraft((d) => ({ ...d, callMe: e.target.value }))} style={{ width: 160 }} data-testid="pref-callme" />
            <BusyButton busy={busy === 'callMe'} busyLabel="Keeping…" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => void change('callMe', { answer: { callMe: draft.callMe.trim() || null } })}>Keep</BusyButton>
          </span>],
        ]} />
      )}
      <Micro>Or just say it: &ldquo;answer me briefly&rdquo;, &ldquo;call me Ali&rdquo;, &ldquo;answer in Spanish&rdquo;, &ldquo;stop emailing me&rdquo;.</Micro>
    </Card>
  );
}
