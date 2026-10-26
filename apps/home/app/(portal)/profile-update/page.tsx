'use client';
// SAVE A PROFILE CHANGE AN APP PROPOSED — opened by the app in a small window (`/profile-update?p=<token>&from=<app>`).
// An app may read the person's profile and never write it, so the change it offers is shown here beside what the
// profile holds now, and saved — with this Home's session — only on the person's "Save". Fields the change does not
// name are left exactly as they are (the record is read fresh and merged).
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { loadImpactProfile, saveImpactProfile, isProfilePhoto, type ImpactContactProfile } from '../../../src/profile-store';

interface Fields { firstName?: string; lastName?: string; photo?: string | null }

const fullName = (c: { firstName?: string; lastName?: string }) =>
  [c.firstName, c.lastName].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');

export default function ProfileUpdatePage() {
  const { session, agentAddress, refreshPersonName } = useSession();
  const [fields, setFields] = useState<Fields | null>(null);
  const [current, setCurrent] = useState<ImpactContactProfile | null>(null);
  const [app, setApp] = useState('the app');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'done' | 'error'>('loading');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!session || !agentAddress) return;
    const q = new URLSearchParams(window.location.search);
    const token = q.get('p') ?? '';
    const from = (q.get('from') ?? '').trim();
    if (from) setApp(from === 'seed-reader' ? 'Seed Bible' : from);
    void (async () => {
      try {
        const res = await fetch(`/connect/profile-proposal?token=${encodeURIComponent(token)}`, {
          headers: { authorization: `Bearer ${session.token}` },
        });
        const out = (await res.json()) as { ok?: boolean; fields?: Fields; error?: string };
        if (!res.ok || !out.fields) throw new Error(out.error ?? `the change could not be read (${res.status})`);
        setFields(out.fields);
        setCurrent((await loadImpactProfile(agentAddress as Address)).contact ?? {});
        setState('ready');
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
        setState('error');
      }
    })();
  }, [session, agentAddress]);

  const save = async () => {
    if (!fields || !agentAddress) return;
    setState('saving');
    try {
      const cur = await loadImpactProfile(agentAddress as Address);
      const contact: ImpactContactProfile = { ...(cur.contact ?? {}) };
      if (fields.firstName !== undefined) contact.firstName = fields.firstName;
      if (fields.lastName !== undefined) contact.lastName = fields.lastName;
      if (fields.photo === null) delete contact.photo;
      else if (fields.photo !== undefined && isProfilePhoto(fields.photo)) contact.photo = fields.photo;
      await saveImpactProfile(agentAddress as Address, { ...cur, contact });
      await refreshPersonName().catch(() => undefined);
      setState('done');
      setTimeout(() => window.close(), 1200);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  };

  const nameNow = current ? fullName(current) : '';
  const nameNew = fields && (fields.firstName !== undefined || fields.lastName !== undefined)
    ? fullName({ firstName: fields.firstName ?? current?.firstName, lastName: fields.lastName ?? current?.lastName })
    : null;
  const photoNew = fields?.photo;
  const box: React.CSSProperties = { border: '1px solid rgba(0,0,0,.12)', borderRadius: 10, padding: 14, margin: '12px 0' };
  const pic = (src: string | null | undefined) =>
    src ? <img src={src} alt="" width={56} height={56} style={{ borderRadius: '50%', objectFit: 'cover' }} /> : <span style={{ opacity: 0.6 }}>no photo</span>;

  return (
    <div style={{ maxWidth: 440, margin: '6vh auto', padding: '0 20px' }} data-testid="profile-update">
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>Update your Home profile?</h1>
      <p style={{ opacity: 0.75, marginTop: 0 }}>{app} asks to change what your profile shows. Your profile is kept here, at your Home; apps you let read it show the same name and photo.</p>
      {state === 'loading' && <p>Getting it ready…</p>}
      {state === 'error' && (
        <>
          <p role="alert">{msg}</p>
          <button type="button" className="btn" onClick={() => window.close()}>Close</button>
        </>
      )}
      {(state === 'ready' || state === 'saving') && fields && (
        <>
          {nameNew !== null && (
            <div style={box}>
              <div style={{ fontSize: 13, opacity: 0.7 }}>Name</div>
              <div style={{ textDecoration: 'line-through', opacity: 0.6 }}>{nameNow || 'none'}</div>
              <div style={{ fontWeight: 600 }}>{nameNew || 'none'}</div>
            </div>
          )}
          {photoNew !== undefined && (
            <div style={{ ...box, display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ fontSize: 13, opacity: 0.7, width: 50 }}>Photo</div>
              <div style={{ opacity: 0.6 }}>{pic(isProfilePhoto(current?.photo) ? current?.photo : null)}</div>
              <span aria-hidden="true">→</span>
              <div>{pic(photoNew)}</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn primary" disabled={state === 'saving'} onClick={() => void save()} data-testid="profile-update-save">
              {state === 'saving' ? 'Saving…' : 'Save to my profile'}
            </button>
            <button type="button" className="btn" disabled={state === 'saving'} onClick={() => window.close()}>Not now</button>
          </div>
        </>
      )}
      {state === 'done' && <p style={{ fontWeight: 600 }}>Saved — taking you back.</p>}
    </div>
  );
}
