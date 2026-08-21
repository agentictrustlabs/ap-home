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

  return (
    <div className="dev-apps">
      <section className="dash-section">
        <h3>What registering does</h3>
        <p className="muted">
          It lets your app send people to this Home to sign in, and it tells them your app&apos;s name when
          they get here. It grants nothing on its own — every sign-in is still a ceremony the person runs
          with their own credential, and every authority your app ends up holding is a delegation
          <em> they</em> signed and can revoke on-chain without asking this Home.
        </p>
      </section>

      {error && <p className="settings-banner settings-banner--error">{error}</p>}

      <section className="dash-section">
        <h3>{editing ? `Edit ${editing}` : 'Register an app'}</h3>
        <div className="settings-field">
          <label htmlFor="app-id">App ID</label>
          <input
            id="app-id"
            value={form.client_id}
            disabled={!!editing}
            placeholder="my-app"
            onChange={(e) => setForm({ ...form, client_id: e.target.value })}
          />
          <p className="settings-field__help">
            Your OIDC <code>client_id</code>, and the <code>aud</code> of every token this Home mints for
            you. Lowercase letters, digits and single dashes. Permanent once registered.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="app-name">Display name</label>
          <input
            id="app-name"
            value={form.name}
            placeholder="My App"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <p className="settings-field__help">Shown to people on the consent screen. Make it what they would recognise.</p>
        </div>

        <div className="settings-field">
          <label htmlFor="app-redirects">Redirect URIs — one per line</label>
          <textarea
            id="app-redirects"
            rows={4}
            value={form.redirects}
            placeholder={'https://my-app.example.com/\nhttp://localhost:5173/'}
            onChange={(e) => setForm({ ...form, redirects: e.target.value })}
          />
          <p className="settings-field__help">
            Matched <strong>exactly</strong> — not by prefix. A trailing slash matters. https only, except
            on <code>localhost</code>. They cannot be on this Home&apos;s own domain, and an origin can
            belong to one app.
          </p>
        </div>

        <div className="settings-field">
          <label>What your app may ask for</label>
          <label className="dev-apps__check">
            <input type="checkbox" checked disabled />
            <span>
              <strong>site-login</strong> — sign in, and receive a scoped delegation to your app&apos;s
              backend account.
            </span>
          </label>
          <label className="dev-apps__check">
            <input
              type="checkbox"
              checked={form.templates.includes('org-create')}
              onChange={(e) =>
                setForm({
                  ...form,
                  templates: e.target.checked ? ['site-login', 'org-create'] : ['site-login'],
                })
              }
            />
            <span>
              <strong>org-create</strong> — additionally let a person pick an organization they belong to, or
              name a new one their own credential custodies. A steward may hand your app a scoped org grant;
              a member connects as themselves with that organization as context.
            </span>
          </label>
          <p className="settings-field__help">
            Other templates — payments, subscriptions, content signing — reach further than sign-in and
            stay curated by this deployment.
          </p>
        </div>

        <details className="settings-field">
          <summary>Advanced: your backend account</summary>
          <label htmlFor="app-delegate">Delegate address</label>
          <input
            id="app-delegate"
            value={form.delegate}
            placeholder="leave blank to use the shared demo delegate"
            onChange={(e) => setForm({ ...form, delegate: e.target.value })}
          />
          <p className="settings-field__help">
            The account this Home scopes its grants TO — a <em>delegate</em>, never a custodian. Compromising
            it yields something people revoke; it never becomes control of their identity.
          </p>
        </details>

        <div className="dev-apps__row">
          <button className="btn-primary" disabled={busy} onClick={() => void submit(editing ? 'update' : 'create')}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Register'}
          </button>
          {editing && (
            <button
              className="btn-ghost"
              onClick={() => {
                setEditing(null);
                setForm({ ...BLANK });
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </section>

      <section className="dash-section">
        <h3>Registered</h3>
        {loaded && apps.length === 0 && <p className="muted">Nothing registered yet.</p>}
        {apps.map((a) => (
          <div key={a.client_id} className="dev-apps__item">
            <div className="dev-apps__row">
              <strong>{a.name}</strong>
              <code>{a.client_id}</code>
              {a.disabled && <span className="badge">disabled</span>}
              <span className="dev-apps__spacer" />
              <button className="link" onClick={() => beginEdit(a)}>
                edit
              </button>
              <button className="link dev-apps__danger" disabled={busy} onClick={() => void remove(a.client_id)}>
                delete
              </button>
            </div>
            <ul className="dev-apps__uris">
              {a.redirect_uris.map((u) => (
                <li key={u}>
                  <code>{u}</code>
                </li>
              ))}
            </ul>
            <p className="settings-field__help">
              templates: {a.allowed_delegation_templates.join(', ')} · delegate <code>{a.delegate}</code>
            </p>
          </div>
        ))}
        {apps.length > 0 && (
          <p className="settings-field__help">
            Deleting a registration stops this Home issuing new tokens for it. It does <strong>not</strong>{' '}
            revoke delegations people already signed — those are on-chain, and each person revokes their own
            from their authority page. Anything else would be a revoke that only works here.
          </p>
        )}
      </section>

      {integration && (
        <section className="dash-section">
          <h3>Point your app at this Home</h3>
          <table className="dev-apps__facts">
            <tbody>
              <tr>
                <td>Issuer</td>
                <td>
                  <code>{integration.issuer}</code>
                </td>
              </tr>
              <tr>
                <td>Discovery</td>
                <td>
                  <code>{integration.discovery}</code>
                </td>
              </tr>
              <tr>
                <td>Authorization</td>
                <td>
                  <code>{integration.authorizationEndpoint}</code>
                </td>
              </tr>
              <tr>
                <td>Token</td>
                <td>
                  <code>{integration.tokenEndpoint}</code>
                </td>
              </tr>
              <tr>
                <td>JWKS</td>
                <td>
                  <code>{integration.jwksUri}</code>
                </td>
              </tr>
              <tr>
                <td>Flow</td>
                <td>
                  <code>
                    response_type={integration.responseType} · PKCE {integration.codeChallengeMethod}
                  </code>
                </td>
              </tr>
              <tr>
                <td>Scopes</td>
                <td>
                  <code>{integration.availableScopes.join(' ')}</code>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="settings-field__help">{integration.issuerNote}</p>
        </section>
      )}

    </div>
  );
}
