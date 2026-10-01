'use client';
// "Your apps" — the member-owned OIDC client registry (spec 230 §6, self-service half).
//
// The decision this page hands to the member: which apps may send people HERE to sign in. It is
// their decision because it is their Home, and because the alternative — a config edit and a
// redeploy by whoever operates the deployment — made a member-scale choice into an operator-scale
// one.
//
// What registering does NOT do, said on the page as well as here: it grants nothing. Every
// sign-in through a registered app is still a ceremony the person runs with their own credential,
// ending in a delegation they sign, scoped by a template the app cannot widen, and revocable
// on-chain without this Home's cooperation. Deleting a registration stops new tokens; it does not
// revoke the delegations already signed. That distinction is the whole reason per-app grants
// exist, so the page says it rather than implying a delete is a revoke.

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import './developer-apps.css';
import { Panel } from '../../ui/panel';
import { CodeIcon, GlobeIcon, LinkIcon } from '../shared/Icons';

interface RegisteredApp {
  client_id: string;
  name: string;
  description?: string;
  homepage?: string;
  owner: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  allowed_delegation_templates: string[];
  delegate: string;
  createdAt: string;
  updatedAt: string;
  disabled?: boolean;
}

interface Integration {
  issuer: string;
  discovery: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  responseType: string;
  codeChallengeMethod: string;
  availableScopes: string[];
  availableTemplates: string[];
  issuerNote: string;
}

const BLANK = {
  client_id: '',
  name: '',
  description: '',
  homepage: '',
  redirects: '',
  templates: ['site-login'] as string[],
  delegate: '',
};

export function DeveloperApps() {
  const { session } = useSession();
  const token = session?.token ?? '';

  const [apps, setApps] = useState<RegisteredApp[]>([]);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch('/connect/apps', { headers: { authorization: `Bearer ${token}` } });
      const b = (await r.json().catch(() => ({}))) as { apps?: RegisteredApp[]; integration?: Integration; error?: string };
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      setApps(b.apps ?? []);
      setIntegration(b.integration ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (action: 'create' | 'update') => {
    setBusy(true);
    setError('');
    try {
      const redirect_uris = form.redirects
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const r = await fetch('/connect/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action,
          client_id: form.client_id,
          name: form.name,
          description: form.description || undefined,
          homepage: form.homepage || undefined,
          redirect_uris,
          allowed_delegation_templates: form.templates,
          delegate: form.delegate || undefined,
        }),
      });
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      setForm({ ...BLANK });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (clientId: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/connect/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'delete', client_id: clientId }),
      });
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (a: RegisteredApp) => {
    setEditing(a.client_id);
    setForm({
      client_id: a.client_id,
      name: a.name,
      description: a.description ?? '',
      homepage: a.homepage ?? '',
      redirects: a.redirect_uris.join('\n'),
      templates: a.allowed_delegation_templates,
      delegate: a.delegate,
    });
  };

  if (!token) return <p className="muted">Sign in to manage your apps.</p>;

  const TEMPLATE_WORDS: Record<string, string> = { 'site-login': 'sign people in', 'org-create': 'let them choose or create an organization' };
  const formTitle = editing ? `Edit ${apps.find((a) => a.client_id === editing)?.name ?? editing}` : 'Register an app';

  return (
    <div className="dev-apps">
      {/* 1. What this is for, in three steps — before any field. */}
      <Panel title="How an app uses this Home to sign people in" icon={<LinkIcon size={18} />} state="ready" testId="dev-apps-how">
        <div className="ui-panel-body">
          <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li style={{ marginBottom: '.35rem' }}><b>Register your app below.</b> Give it a short ID, the name people will see, and the address in your app that people come back to after signing in.</li>
            <li style={{ marginBottom: '.35rem' }}><b>Point your app at this Home.</b> It is a standard OpenID Connect sign-in; the addresses to paste into your app are at the bottom of this page.</li>
            <li><b>People sign in with their own credential.</b> Your app learns who they are and receives a scoped grant <em>they</em> signed. Registering grants nothing by itself, and a person can take any grant back without asking this Home.</li>
          </ol>
        </div>
      </Panel>

      {error && <p className="settings-banner settings-banner--error">{error}</p>}

      {/* 2. What is registered — its own panel, labelled, with an honest empty state. */}
      <Panel title="Apps you registered" icon={<GlobeIcon size={18} />} state={!loaded ? 'loading' : apps.length === 0 ? 'empty' : 'ready'} count={loaded ? apps.length : undefined} testId="dev-apps-registered"
        empty={{ title: 'You have not registered an app yet', hint: 'Use the form below. Once registered, the app appears here with the addresses it may send people back to.' }}>
        {apps.map((a) => (
          <div key={a.client_id} className="dev-apps__item" data-testid={`dev-app-${a.client_id}`}>
            <div className="dev-apps__row">
              <strong>{a.name}</strong>
              <span className="muted">ID <code>{a.client_id}</code></span>
              {a.disabled && <span className="badge">disabled</span>}
              <span className="dev-apps__spacer" />
              <button className="btn-ghost" onClick={() => beginEdit(a)}>Edit</button>
              <button className="btn-ghost dev-apps__danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${a.name}? New sign-ins through it stop. Grants people already signed stay theirs to revoke.`)) void remove(a.client_id); }}>Remove</button>
            </div>
            <p className="settings-field__help" style={{ margin: '.3rem 0 .1rem' }}>Sends people back to:</p>
            <ul className="dev-apps__uris">
              {a.redirect_uris.map((u) => (<li key={u}><code>{u}</code></li>))}
            </ul>
            <p className="settings-field__help">May {a.allowed_delegation_templates.map((t) => TEMPLATE_WORDS[t] ?? t).join(' · ')} · backend account <code>{a.delegate}</code></p>
          </div>
        ))}
        {apps.length > 0 && (
          <p className="settings-field__help">Removing an app stops this Home issuing new sign-ins for it. It does <strong>not</strong> revoke what people already granted — each person revokes their own grants from their Home.</p>
        )}
      </Panel>

      {/* 3. The form, in plain words. */}
      <Panel title={formTitle} icon={<CodeIcon size={18} />} state="ready" testId="dev-apps-form">
        <div className="ui-panel-body">
          <div className="settings-field">
            <label htmlFor="app-id">App ID — a short name for your app</label>
            <input id="app-id" value={form.client_id} disabled={!!editing} placeholder="my-app" onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
            <p className="settings-field__help">Lowercase letters, digits and single dashes, like <code>my-app</code>. Your app sends it as its <code>client_id</code>. It cannot be changed once registered.</p>
          </div>

          <div className="settings-field">
            <label htmlFor="app-name">Name people see</label>
            <input id="app-name" value={form.name} placeholder="My App" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <p className="settings-field__help">Shown on the sign-in screen as &ldquo;Allow <em>{form.name.trim() || 'My App'}</em>?&rdquo; Use the name people already know your app by.</p>
          </div>

          <div className="settings-field">
            <label htmlFor="app-redirects">Where to send people back after they sign in — one address per line</label>
            <textarea id="app-redirects" rows={4} value={form.redirects} placeholder={'https://my-app.example.com/auth/callback\nhttp://localhost:5173/auth/callback'} onChange={(e) => setForm({ ...form, redirects: e.target.value })} />
            <p className="settings-field__help">
              <b>Required.</b> This is the page in <em>your</em> app that receives the sign-in (your OAuth redirect or callback URL). Put your live address on one line and, while you are building, a <code>localhost</code> address on another.
              Each must match what your app sends <strong>exactly</strong> — a trailing slash counts. <code>https</code> only, except on <code>localhost</code>. It cannot be on this Home&apos;s own domain, and one address can belong to one app only.
            </p>
          </div>

          <div className="settings-field">
            <label>What your app may ask for</label>
            <label className="dev-apps__check">
              <input type="checkbox" checked disabled />
              <span><strong>Sign people in</strong> (always). Your app learns who the person is and receives a scoped grant to its backend account.</span>
            </label>
            <label className="dev-apps__check">
              <input type="checkbox" checked={form.templates.includes('org-create')} onChange={(e) => setForm({ ...form, templates: e.target.checked ? ['site-login', 'org-create'] : ['site-login'] })} />
              <span><strong>Also let them choose or create an organization.</strong> A person picks an organization they belong to, or names a new one their own credential custodies. A steward may hand your app a scoped grant from that organization; a member connects as themselves with the organization as context.</span>
            </label>
            <p className="settings-field__help">Anything that reaches further than sign-in — payments, subscriptions, content signing — is set up by whoever runs this deployment, not from this form.</p>
          </div>

          <details className="settings-field">
            <summary>Advanced: your app&apos;s backend account (optional)</summary>
            <label htmlFor="app-delegate">Backend account address</label>
            <input id="app-delegate" value={form.delegate} placeholder="leave blank to use the shared demo account" onChange={(e) => setForm({ ...form, delegate: e.target.value })} />
            <p className="settings-field__help">The account this Home scopes people&apos;s grants <em>to</em>. It receives permissions; it never controls anyone&apos;s identity. If it were compromised, people would revoke what they granted it, and nothing more is lost.</p>
          </details>

          <div className="dev-apps__row">
            <button className="btn-primary" disabled={busy} onClick={() => void submit(editing ? 'update' : 'create')}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Register this app'}
            </button>
            {editing && (<button className="btn-ghost" onClick={() => { setEditing(null); setForm({ ...BLANK }); }}>Cancel</button>)}
          </div>
        </div>
      </Panel>

      {/* 4. What the app needs from this Home — the standard OpenID Connect facts. */}
      {integration && (
        <Panel title="Point your app at this Home" icon={<LinkIcon size={18} />} state="ready" testId="dev-apps-integration">
          <div className="ui-panel-body">
            <p className="settings-field__help" style={{ marginTop: 0 }}>Paste these into your app&apos;s OpenID Connect settings. Most libraries need only the discovery address and your App ID.</p>
            <table className="dev-apps__facts">
              <tbody>
                <tr><td>Issuer</td><td><code>{integration.issuer}</code></td></tr>
                <tr><td>Discovery</td><td><code>{integration.discovery}</code></td></tr>
                <tr><td>Authorization</td><td><code>{integration.authorizationEndpoint}</code></td></tr>
                <tr><td>Token</td><td><code>{integration.tokenEndpoint}</code></td></tr>
                <tr><td>JWKS</td><td><code>{integration.jwksUri}</code></td></tr>
                <tr><td>Flow</td><td><code>response_type={integration.responseType} · PKCE {integration.codeChallengeMethod}</code></td></tr>
                <tr><td>Scopes</td><td><code>{integration.availableScopes.join(' ')}</code></td></tr>
              </tbody>
            </table>
            <p className="settings-field__help">{integration.issuerNote}</p>
          </div>
        </Panel>
      )}
    </div>
  );
}
