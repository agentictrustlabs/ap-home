'use client';
// `/securitySchemes` — a map of name → scheme where each scheme is EXACTLY ONE type (design §3.6).
// Picking a type SWAPS the field set rather than graying out four foreign field sets: a grayed-out
// irrelevant field invites "maybe I should fill this in anyway", and `validateScheme` rejects any scheme
// carrying a foreign type's fields (`SECURITY_SCHEME_INVALID`).
import { useState } from 'react';
import type { A2ASecuritySchemeV1 } from '@agenticprimitives/agent-profile/a2a';
import { A2A_SECURITY_SCHEME_TYPES } from '@agenticprimitives/agent-profile/a2a';
import { iconButtonStyle, inputStyle } from './ui';

type SchemeType = (typeof A2A_SECURITY_SCHEME_TYPES)[number];

const TYPE_LABEL: Record<SchemeType, string> = {
  apiKey: 'API key',
  http: 'HTTP',
  oauth2: 'OAuth 2.0',
  openIdConnect: 'OpenID Connect',
  mutualTLS: 'Mutual TLS',
};

function emptyScheme(type: SchemeType): A2ASecuritySchemeV1 {
  switch (type) {
    case 'apiKey':
      return { type: 'apiKey', name: '', in: 'header' };
    case 'http':
      return { type: 'http', scheme: 'bearer' };
    case 'oauth2':
      return { type: 'oauth2', flows: {} };
    case 'openIdConnect':
      return { type: 'openIdConnect', openIdConnectUrl: '' };
    case 'mutualTLS':
      return { type: 'mutualTLS' };
  }
}

function SchemeFields({
  scheme,
  readOnly,
  onChange,
}: {
  scheme: A2ASecuritySchemeV1;
  readOnly: boolean;
  onChange(next: A2ASecuritySchemeV1): void;
}) {
  if (scheme.type === 'apiKey') {
    return (
      <div style={{ display: 'grid', gap: '.35rem' }}>
        <input aria-label="Parameter name" placeholder="X-API-Key" value={scheme.name} disabled={readOnly} onChange={(e) => onChange({ ...scheme, name: e.target.value })} style={inputStyle} />
        <select aria-label="Sent in" value={scheme.in} disabled={readOnly} onChange={(e) => onChange({ ...scheme, in: e.target.value as 'header' | 'query' | 'cookie' })} style={inputStyle}>
          <option value="header">header</option>
          <option value="query">query</option>
          <option value="cookie">cookie</option>
        </select>
      </div>
    );
  }
  if (scheme.type === 'http') {
    return (
      <div style={{ display: 'grid', gap: '.35rem' }}>
        <input aria-label="Scheme" placeholder="Bearer" value={scheme.scheme} disabled={readOnly} onChange={(e) => onChange({ ...scheme, scheme: e.target.value })} style={inputStyle} />
        <input aria-label="Bearer format (optional)" placeholder="JWT" value={scheme.bearerFormat ?? ''} disabled={readOnly} onChange={(e) => onChange({ ...scheme, bearerFormat: e.target.value || undefined })} style={inputStyle} />
      </div>
    );
  }
  if (scheme.type === 'openIdConnect') {
    return (
      <input
        aria-label="OpenID Connect discovery URL"
        placeholder="https://…/.well-known/openid-configuration"
        value={scheme.openIdConnectUrl}
        disabled={readOnly}
        onChange={(e) => onChange({ ...scheme, openIdConnectUrl: e.target.value })}
        style={inputStyle}
      />
    );
  }
  if (scheme.type === 'oauth2') {
    const cc = scheme.flows.clientCredentials;
    return (
      <div style={{ display: 'grid', gap: '.35rem' }}>
        <input
          aria-label="Client-credentials token URL"
          placeholder="https://…/oauth/token"
          value={cc?.tokenUrl ?? ''}
          disabled={readOnly}
          onChange={(e) => onChange({ ...scheme, flows: { ...scheme.flows, clientCredentials: { ...(cc ?? { scopes: {} }), tokenUrl: e.target.value } } })}
          style={inputStyle}
        />
        <input
          aria-label="OAuth 2.0 metadata URL (optional)"
          placeholder="https://…/.well-known/oauth-authorization-server"
          value={scheme.oauth2MetadataUrl ?? ''}
          disabled={readOnly}
          onChange={(e) => onChange({ ...scheme, oauth2MetadataUrl: e.target.value || undefined })}
          style={inputStyle}
        />
      </div>
    );
  }
  return <p className="manage-card-blurb">Mutual TLS carries no further configuration on the card.</p>;
}

export function SecuritySchemesEditor({
  schemes,
  readOnly,
  onCommit,
}: {
  schemes: Record<string, A2ASecuritySchemeV1>;
  readOnly: boolean;
  onCommit(next: Record<string, A2ASecuritySchemeV1>): void;
}) {
  const [newName, setNewName] = useState('');
  const entries = Object.entries(schemes);
  return (
    <div>
      <p className="manage-card-blurb" style={{ margin: '0 0 .5rem', fontWeight: 600 }}>
        Never a secret. These describe how a client authenticates — not the credential itself.
      </p>
      {entries.length === 0 && <p className="manage-card-blurb">No schemes declared. Clients will see no authentication requirement.</p>}
      <div style={{ display: 'grid', gap: '.5rem' }}>
        {entries.map(([name, scheme]) => (
          <div key={name} style={{ border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
              <span style={{ fontSize: '.8rem', fontWeight: 700, flex: 1 }}>{name}</span>
              {!readOnly && (
                <button
                  type="button"
                  style={iconButtonStyle}
                  aria-label={`Remove ${name}`}
                  onClick={() => onCommit(Object.fromEntries(entries.filter(([n]) => n !== name)))}
                >
                  Remove
                </button>
              )}
            </div>
            <div role="radiogroup" aria-label={`${name} type`} style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', margin: '.45rem 0' }}>
              {A2A_SECURITY_SCHEME_TYPES.map((t) => (
                <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: '.25rem', fontSize: '.78rem', minHeight: 32 }}>
                  <input
                    type="radio"
                    name={`scheme-type-${name}`}
                    checked={scheme.type === t}
                    disabled={readOnly}
                    onChange={() => onCommit({ ...schemes, [name]: emptyScheme(t) })}
                  />
                  {TYPE_LABEL[t]}
                </label>
              ))}
            </div>
            <SchemeFields scheme={scheme} readOnly={readOnly} onChange={(next) => onCommit({ ...schemes, [name]: next })} />
          </div>
        ))}
      </div>
      {!readOnly && (
        <div style={{ display: 'flex', gap: '.35rem', marginTop: '.5rem' }}>
          <input aria-label="New scheme name" placeholder="bearer-jwt" value={newName} onChange={(e) => setNewName(e.target.value)} style={inputStyle} />
          <button
            type="button"
            className="btn-ghost"
            disabled={!newName.trim() || newName.trim() in schemes}
            onClick={() => {
              onCommit({ ...schemes, [newName.trim()]: emptyScheme('http') });
              setNewName('');
            }}
          >
            Add scheme
          </button>
        </div>
      )}
    </div>
  );
}
